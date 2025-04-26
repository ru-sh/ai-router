import express, { Request, Response } from "express";
import axios from "axios";
import * as dotenv from "dotenv";
import { URL } from "url";
dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8034;
if (isNaN(PORT)) {
    throw new Error("Invalid PORT value in environment variables");
}

/**
 * Validates whether a given string is a valid URL.
 * @param urlString The URL string to validate.
 * @returns True if the URL is valid, false otherwise.
 */
function isValidUrl(urlString: string): boolean {
    try {
        new URL(urlString);
        return true;
    } catch (_) {
        return false;
    }
}

// Log configured AI services on startup
console.log("Configured AI Services:");
const serviceKeys = Object.keys(process.env).filter(key =>
    key.startsWith("AI_SERVICE_")
);

if (serviceKeys.length === 0) {
    console.log("  No AI services configured using AI_SERVICE_* environment variables.");
} else {
    serviceKeys.forEach(key => {
        const baseUrl = process.env[key];
        const serviceName = key.replace("AI_SERVICE_", "");
        if (baseUrl) {
            if (isValidUrl(baseUrl)) {
                console.log(`  - ${serviceName}: ${baseUrl}`);
            } else {
                console.warn(`  - ${serviceName}: Invalid URL - ${baseUrl}`);
            }
        }
    });
}
console.log("--------------------------");


app.use(express.json());

/**
 * Endpoint to fetch available models from all AI services.
 * @param req Express request object.
 * @param res Express response object.
 */
app.get("/api/tags", async (req: Request, res: Response) => {
    try {
        const serviceKeys = Object.keys(process.env).filter(key =>
            key.startsWith("AI_SERVICE_")
        );

        const requests = serviceKeys.map(key => {
            const baseUrl = process.env[key];
            const serviceName = key.replace("AI_SERVICE_", "");
            if (!baseUrl || !isValidUrl(baseUrl)) {
                console.error(`Invalid URL for ${key}: ${baseUrl}`);
                return Promise.resolve([]); // Return empty array for invalid services
            }
            return axios.get(`${baseUrl}/api/tags`, { timeout: 5000 })
                .then(response => {
                    if (response.data && Array.isArray(response.data.models)) {
                        return response.data.models.map((model: any) => ({
                            ...model,
                            name: `${serviceName}/${model.name}`
                        }));
                    }
                    console.warn(`Service ${serviceName} at ${baseUrl} did not return a valid models array.`);
                    return [];
                })
                .catch(error => {
                    console.error(`Error fetching models from ${baseUrl}:`, error.message);
                    return [];
                });
        });

        const results = await Promise.all(requests);
        const models = results.flat();
        res.json({ models });
    } catch (error) {
        let errorMessage = "An unknown error occurred";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        console.error("Error in /api/tags:", errorMessage);
        res.status(500).json({ error: errorMessage });
    }
});

interface ModelRequest {
    model: string;
    [key: string]: any;
}

/**
 * Extracts the target URL and payload by removing the service prefix from the model.
 * Validates the model format and retrieves the base URL for the specified service.
 * @param req Express request object.
 * @param endpointSuffix The endpoint to target (e.g., "generate" or "chat").
 * @returns An object containing the targetUrl and modified payload.
 * @throws Error if the model is invalid or the service is not found or has an invalid URL.
 */
function extractTarget(req: Request, endpointSuffix: string): { targetUrl: string, payload: ModelRequest } {
    const body = req.body as ModelRequest;
    const { model, name, ...rest } = body;
    if (!model  && !name){
        console.warn('Cannot find model name.')
        return {targetUrl: req.url, payload: body};
    }
    const [serviceName, ...modelParts] = (model ?? name).split("/");
    if (!serviceName || modelParts.length === 0) {
        throw new Error("Invalid model format. Expected format 'ServiceName/modelName'");
    }

    // Remove the service name prefix from the model.
    const newModelName = modelParts.join("/");

    const baseUrl = process.env[`AI_SERVICE_${serviceName}`];
    if (!baseUrl || !isValidUrl(baseUrl)) {
        // This should ideally not happen if invalid URLs are filtered during startup/tags fetch,
        // but keeping the check for robustness.
        throw new Error(`Service not found or invalid URL for service ${serviceName}`);
    }
    const targetUrl = `${baseUrl}/api/${endpointSuffix}`;
    const payload: ModelRequest = { ...rest, model: newModelName };
    return { targetUrl, payload };
}

/**
 * Handles a proxied POST endpoint with streaming response.
 * Extracts the target URL and payload, sends the request to the specified service,
 * and streams the response back to the client.
 * @param endpointSuffix The endpoint to target on the remote service (e.g., "generate" or "chat").
 * @param req Express request object.
 * @param res Express response object.
 */
async function proxyPost(endpointSuffix: string, req: Request, res: Response) {
    const { targetUrl, payload } = extractTarget(req, endpointSuffix);
    try {
        const response = await axios.post(targetUrl, payload, {
            timeout: 300000, // Increased timeout for potentially long operations
            responseType: "stream"
        });

        // Forward status code and headers (except transfer-encoding and connection)
        res.status(response.status);
        for (const header in response.headers) {
             if (header.toLowerCase() !== 'transfer-encoding' && header.toLowerCase() !== 'connection') {
                res.setHeader(header, response.headers[header]);
             }
        }

        // Pipe the response stream to the client response
        response.data.pipe(res);

        // Handle stream close and errors
        response.data.on('end', () => {
            console.debug(`Proxy stream to ${targetUrl} ended.`);
        });
        response.data.on('error', (err: any) => {
            console.error(`Stream error from ${targetUrl}:`, err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: `Stream error from target service: ${err.message}` });
            } else {
                // If headers were sent, just close the connection with the error
                res.end();
            }
        });

    } catch (error) {
        let errorMessage = "An unknown error occurred during proxying";
        let statusCode = 500;
        if (error instanceof Error) {
            errorMessage = error.message;
            // Check for specific axios errors
            if (axios.isAxiosError(error)) {
                 if (error.response) {
                    statusCode = error.response.status;
                    // Try to get a more specific error message from the response body if available
                    if (error.response.data) {
                        try {
                            errorMessage = JSON.stringify(error.response.data);
                        } catch (e) {
                           errorMessage = `Request failed with status code ${statusCode}`;
                        }
                    } else {
                         errorMessage = `Request failed with status code ${statusCode}`;
                    }
                 } else if (error.request) {
                     errorMessage = "No response received from target service";
                     statusCode = 504; // Gateway Timeout
                 } else {
                     errorMessage = `Error setting up request: ${error.message}`;
                 }
            }
        }
        console.error(`Error proxying request to ${targetUrl}:`, payload, errorMessage);
        if (!res.headersSent) {
            res.status(statusCode).json({ error: errorMessage });
        } else {
             // If headers were already sent (e.g., partial stream sent), just end the response
             res.end();
        }
    }
}

/**
 * Endpoint to handle the 'generate' request by proxying it to the appropriate AI service.
 * @param req Express request object.
 * @param res Express response object.
 */
app.post("/api/generate", async (req: Request, res: Response) => {
    await proxyPost("generate", req, res);
});

/**
 * Endpoint to handle the 'chat' request by proxying it to the appropriate AI service.
 * @param req Express request object.
 * @param res Express response object.
 */
app.post("/api/chat", async (req: Request, res: Response) => {
    await proxyPost("chat", req, res);
});

/**
 * Endpoint to handle the 'show' request by proxying it to the appropriate AI service.
 * @param req Express request object.
 * @param res Express response object.
 */
app.post("/api/show", async (req: Request, res: Response) => {
    await proxyPost("show", req, res);
});


const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

process.on('SIGINT', () => {
    console.info("Shutting down the server...");
    server.close(() => {
        console.info("Server has been terminated");
    });
});