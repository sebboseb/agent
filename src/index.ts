import { startGateway } from "./server.js";
import { startCanary } from "./canary.js";

startGateway().then(() => startCanary());
