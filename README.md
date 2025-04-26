# ai-router

Routes traffic between multiple Ollama instances

## Getting started

- Set the list of url to ollama instances in the .env file.
- Run the ai-router.
- Configure ollama clients to use the ai-router's endpoint as usual ollama service (with correct port).

By default, ai-router is uses port `8034` not to conflict with ollama running on the same host.
But, you can set it via PORT env to `11434` if there is no ollama running on the same server.
