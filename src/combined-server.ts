#!/usr/bin/env node

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AnyCrawlMCPServer } from './mcp-server.js';

export interface CombinedServerConfig {
    port?: number;
    host?: string;
    baseUrl?: string | undefined;
}

export class CombinedMCPServer {
    private app: express.Application;
    private mcpTransports: Record<string, Record<string, StreamableHTTPServerTransport>> = {};
    private mcpServers: Record<string, Record<string, AnyCrawlMCPServer>> = {};
    private sseTransports: Record<string, Record<string, SSEServerTransport>> = {};
    private sseServers: Record<string, AnyCrawlMCPServer> = {};
    private config: Required<CombinedServerConfig>;

    constructor(config: CombinedServerConfig = {}) {
        this.config = {
            port: config.port || 3000,
            host: config.host || '0.0.0.0',
            baseUrl: config.baseUrl || 'https://api.anycrawl.dev',
        };

        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        this.app.use(helmet());
        this.app.use(express.json({ limit: '5mb' }));
        this.app.use(cors({
            origin: '*',
            exposedHeaders: ['Mcp-Session-Id'],
            allowedHeaders: ['Content-Type', 'mcp-session-id'],
        }));
    }

    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (_req: Request, res: Response) =>
            res.json({ status: 'ok', mode: 'COMBINED' })
        );

        // MCP endpoints with API key routing
        this.app.post('/:apiKey/mcp', this.handleMcpPost.bind(this));
        this.app.get('/:apiKey/mcp', this.handleMcpSession.bind(this));
        this.app.delete('/:apiKey/mcp', this.handleMcpSession.bind(this));

        // SSE endpoints with API key routing
        this.app.get('/:apiKey/sse', this.handleSseGet.bind(this));
        this.app.post('/:apiKey/messages', this.handleSseMessages.bind(this));
    }

    private async handleMcpPost(req: Request, res: Response): Promise<void> {
        const apiKey = req.params.apiKey;
        if (!apiKey) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: API key is required' },
                id: null,
            });
            return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined =
            sessionId && this.mcpTransports[apiKey] ? this.mcpTransports[apiKey][sessionId] : undefined;

        if (sessionId && transport) {
            await transport.handleRequest(req, res, req.body);
            return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
            // Create transport and server for new session
            const newTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,
                onsessioninitialized: (sid) => {
                    if (!this.mcpTransports[apiKey]) {
                        this.mcpTransports[apiKey] = {};
                        this.mcpServers[apiKey] = {};
                    }
                    this.mcpTransports[apiKey][sid] = newTransport;
                },
            });

            const server = new AnyCrawlMCPServer(apiKey, this.config.baseUrl);
            newTransport.onclose = () => {
                if (newTransport.sessionId && this.mcpTransports[apiKey]) {
                    delete this.mcpTransports[apiKey][newTransport.sessionId];
                    if (this.mcpServers[apiKey]) {
                        delete this.mcpServers[apiKey][newTransport.sessionId];
                    }
                }
            };

            if (!this.mcpServers[apiKey]) {
                this.mcpServers[apiKey] = {};
            }
            const sessionId = newTransport.sessionId ?? 'pending';
            this.mcpServers[apiKey][sessionId] = server;
            await server.connectTransport(newTransport);
            await newTransport.handleRequest(req, res, req.body);
            return;
        }

        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
        });
    }

    private async handleMcpSession(req: Request, res: Response): Promise<void> {
        const apiKey = req.params.apiKey;
        if (!apiKey) {
            res.status(400).send('API key is required');
            return;
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !this.mcpTransports[apiKey] || !this.mcpTransports[apiKey][sessionId]) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }

        const transport = this.mcpTransports[apiKey][sessionId];
        await transport.handleRequest(req, res);
    }

    private async handleSseGet(req: Request, res: Response): Promise<void> {
        const apiKey = req.params.apiKey;
        if (!apiKey) {
            res.status(400).send('API key is required');
            return;
        }

        // Create or get server for this API key
        if (!this.sseServers[apiKey]) {
            this.sseServers[apiKey] = new AnyCrawlMCPServer(apiKey, this.config.baseUrl);
        }

        if (!this.sseTransports[apiKey]) {
            this.sseTransports[apiKey] = {};
        }

        // Create SSE transport for this API key
        const transport = new SSEServerTransport(`/${apiKey}/messages`, res);
        this.sseTransports[apiKey][transport.sessionId] = transport;

        res.on("close", () => {
            if (this.sseTransports[apiKey]) {
                delete this.sseTransports[apiKey][transport.sessionId];
            }
        });

        await this.sseServers[apiKey].connectTransport(transport);
    }

    private async handleSseMessages(req: Request, res: Response): Promise<void> {
        const apiKey = req.params.apiKey;
        if (!apiKey) {
            res.status(400).send('API key is required');
            return;
        }

        const sessionId = req.query.sessionId as string;
        const transport = this.sseTransports[apiKey]?.[sessionId];
        if (transport) {
            await transport.handlePostMessage(req, res, req.body);
        } else {
            res.status(400).send('No transport found for sessionId');
        }
    }

    public async start(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.app.listen(this.config.port, this.config.host, () => {
                logger.info(`MCP Combined Server listening on http://${this.config.host}:${this.config.port}`);
                logger.info(`MCP endpoints: http://${this.config.host}:${this.config.port}/{API_KEY}/mcp`);
                logger.info(`SSE endpoints: http://${this.config.host}:${this.config.port}/{API_KEY}/sse`);
                resolve();
            });
        });
    }

    public getApp(): express.Application {
        return this.app;
    }
}
