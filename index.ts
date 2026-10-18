// Entry point for the mcp-use CLI (`mcp-use dev`, `build`, `start`) and Manufact deploys.
import { createEscrowServer } from './src/app.js';

const server = createEscrowServer();

export default server;
