import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxy = process.env.PI_PROXY || "http://127.0.0.1:7897";
setGlobalDispatcher(new ProxyAgent(proxy));
