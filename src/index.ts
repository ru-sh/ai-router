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
                throw new Error(`Invalid URL for ${key}: ${baseUrl}`);
            }
            return axios.get(`${baseUrl}/api/tags`, { timeout: 300000 })
                .then(response => {
                    if (response.data && Array.isArray(response.data.models)) {
                        return response.data.models.map((model: any) => ({
                            ...model,
                            name: `${serviceName}/${model.name}`
                        }));
                    }
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
 * @throws Error if the model is invalid or the service is not found.
 */
function extractTarget(req: Request, endpointSuffix: string): { targetUrl: string, payload: ModelRequest } {
    const body = req.body as ModelRequest;
    const { model, ...rest } = body;
    if (!model || typeof model !== "string") {
        throw new Error("Missing or invalid model name");
    }
    const [serviceName, ...modelParts] = model.split("/");
    if (!serviceName || modelParts.length === 0) {
        throw new Error("Invalid model format. Expected format 'ServiceName/modelName'");
    }

    // Remove the service name prefix from the model.
    const newModelName = modelParts.join("/");

    const baseUrl = process.env[`AI_SERVICE_${serviceName}`];
    if (!baseUrl || !isValidUrl(baseUrl)) {
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
    try {
        const { targetUrl, payload } = extractTarget(req, endpointSuffix);
        console.debug(`Sending to ${targetUrl}`, payload);
        const response = await axios.post(targetUrl, payload, {
            timeout: 300000,
            responseType: "stream"
        });

        res.setHeader("Content-Type", response.headers["content-type"] || "application/json");
        response.data.pipe(res);
    } catch (error) {
        let errorMessage = "An unknown error occurred";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        res.status(500).json({ error: errorMessage });
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