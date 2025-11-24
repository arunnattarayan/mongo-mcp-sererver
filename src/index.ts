import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MongoClient, Db } from "mongodb";

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = process.env.MONGODB_DATABASE || "mycompany";

class MongoDBMCPServer {
  private server: Server;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "mongodb-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private async connectToMongoDB() {
    if (!this.client) {
      try {
        console.error(`Attempting to connect to MongoDB...`);
        console.error(`URI: ${MONGODB_URI}`);
        console.error(`Database: ${DATABASE_NAME}`);
        
        this.client = new MongoClient(MONGODB_URI, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 10000,
          directConnection: true, // Important for Docker MongoDB
        });
        
        await this.client.connect();
        
        // Test the connection
        await this.client.db("admin").command({ ping: 1 });
        
        this.db = this.client.db(DATABASE_NAME);
        console.error(`✓ Successfully connected to MongoDB database: ${DATABASE_NAME}`);
      } catch (error) {
        console.error(`✗ Failed to connect to MongoDB:`, error);
        throw new Error(`MongoDB connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup() {
    if (this.client) {
      await this.client.close();
      console.error("MongoDB connection closed");
    }
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({
        tools: [
          {
            name: "mongodb_query",
            description: "Execute a read-only query on a MongoDB collection with filtering, projection, sorting, and pagination",
            inputSchema: {
              type: "object",
              properties: {
                collection: {
                  type: "string",
                  description: "Name of the collection to query",
                },
                filter: {
                  type: "string",
                  description: "JSON string of MongoDB query filter (e.g., '{\"status\": \"active\"}')",
                },
                projection: {
                  type: "string",
                  description: "JSON string of fields to include/exclude (e.g., '{\"name\": 1, \"_id\": 0}')",
                },
                sort: {
                  type: "string",
                  description: "JSON string of sort specification (e.g., '{\"createdAt\": -1}')",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of documents to return (default: 100)",
                },
                skip: {
                  type: "number",
                  description: "Number of documents to skip",
                },
              },
              required: ["collection"],
            },
          },
          {
            name: "mongodb_count",
            description: "Count documents in a collection matching a filter",
            inputSchema: {
              type: "object",
              properties: {
                collection: {
                  type: "string",
                  description: "Name of the collection",
                },
                filter: {
                  type: "string",
                  description: "JSON string of MongoDB query filter",
                },
              },
              required: ["collection"],
            },
          },
          {
            name: "mongodb_aggregate",
            description: "Run an aggregation pipeline on a collection",
            inputSchema: {
              type: "object",
              properties: {
                collection: {
                  type: "string",
                  description: "Name of the collection",
                },
                pipeline: {
                  type: "string",
                  description: "JSON string of aggregation pipeline stages array",
                },
              },
              required: ["collection", "pipeline"],
            },
          },
          {
            name: "mongodb_distinct",
            description: "Get distinct values for a field in a collection",
            inputSchema: {
              type: "object",
              properties: {
                collection: {
                  type: "string",
                  description: "Name of the collection",
                },
                field: {
                  type: "string",
                  description: "Name of the field to get distinct values from",
                },
                filter: {
                  type: "string",
                  description: "JSON string of MongoDB query filter",
                },
              },
              required: ["collection", "field"],
            },
          },
          {
            name: "mongodb_list_databases",
            description: "List all available databases in the MongoDB instance",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "mongodb_list_collections",
            description: "List all collections in the current database with their stats",
            inputSchema: {
              type: "object",
              properties: {
                database: {
                  type: "string",
                  description: "Optional: database name to list collections from (uses current database if not specified)",
                },
              },
            },
          },
          {
            name: "mongodb_verify_connection",
            description: "Verify MongoDB connection and show current database information",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      })
    );

    // List available resources (collections)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      await this.connectToMongoDB();
      
      const collections = await this.db!.listCollections().toArray();
      
      return {
        resources: collections.map((col) => ({
          uri: `mongodb://${DATABASE_NAME}/${col.name}`,
          mimeType: "application/json",
          name: col.name,
          description: `MongoDB collection: ${col.name}`,
        })),
      };
    });

    // Read resource (get collection schema/sample)
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      await this.connectToMongoDB();
      
      const uri = request.params.uri;
      const match = uri.match(/^mongodb:\/\/([^\/]+)\/(.+)$/);
      
      if (!match) {
        throw new Error("Invalid MongoDB URI format");
      }

      const [, dbName, collectionName] = match;
      
      if (dbName !== DATABASE_NAME) {
        throw new Error(`Database ${dbName} does not match connected database ${DATABASE_NAME}`);
      }

      const collection = this.db!.collection(collectionName);
      
      // Get collection stats
      const stats = await this.db!.command({ collStats: collectionName });
      
      // Get sample documents (up to 5)
      const sampleDocs = await collection.find({}).limit(5).toArray();
      
      // Infer schema from sample documents
      const schema = this.inferSchema(sampleDocs);

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                collection: collectionName,
                stats: {
                  count: stats.count,
                  size: stats.size,
                  avgObjSize: stats.avgObjSize,
                },
                schema,
                sampleDocuments: sampleDocs,
              },
              null,
              2
            ),
          },
        ],
      };
    });

    // List available tools
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [
          {
            name: "analyze_collection",
            description: "Analyze a MongoDB collection and provide insights",
            arguments: [
              {
                name: "collection",
                description: "Name of the collection to analyze",
                required: true,
              },
            ],
          },
          {
            name: "find_recent_records",
            description: "Find recent records in a collection",
            arguments: [
              {
                name: "collection",
                description: "Name of the collection",
                required: true,
              },
              {
                name: "dateField",
                description: "Name of the date field to sort by",
                required: true,
              },
              {
                name: "limit",
                description: "Number of records to return",
                required: false,
              },
            ],
          },
          {
            name: "aggregate_summary",
            description: "Create an aggregation summary for a collection",
            arguments: [
              {
                name: "collection",
                description: "Name of the collection",
                required: true,
              },
              {
                name: "groupBy",
                description: "Field to group by",
                required: true,
              },
              {
                name: "metric",
                description: "Field to calculate metrics on",
                required: false,
              },
            ],
          },
        ],
      };
    });

    // Get prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "analyze_collection": {
          const collection = args?.collection as string;
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please analyze the MongoDB collection "${collection}". Provide insights on:
1. Data distribution and patterns
2. Common field values and their frequencies
3. Data quality observations (missing fields, outliers, etc.)
4. Recommendations for queries or further analysis

Use the mongodb_query tool to explore the data.`,
                },
              },
            ],
          };
        }

        case "find_recent_records": {
          const collection = args?.collection as string;
          const dateField = args?.dateField as string;
          const limitArg = args?.limit;
          const limit = typeof limitArg === 'number' ? limitArg : (typeof limitArg === 'string' ? parseInt(limitArg, 10) : 10);
          
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Find the ${limit} most recent records from the "${collection}" collection, sorted by "${dateField}" in descending order. Use the mongodb_query tool with appropriate parameters.`,
                },
              },
            ],
          };
        }

        case "aggregate_summary": {
          const collection = args?.collection as string;
          const groupBy = args?.groupBy as string;
          const metric = args?.metric as string;
          
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Create an aggregation summary for the "${collection}" collection, grouped by "${groupBy}"${
                    metric ? ` with calculations on "${metric}"` : ""
                  }. Use the mongodb_aggregate tool to perform the analysis.`,
                },
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown prompt: ${name}`);
      }
    });

    // Tool handlers
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        await this.connectToMongoDB();
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "MongoDB Connection Failed",
                  message: error instanceof Error ? error.message : String(error),
                  uri: MONGODB_URI.replace(/\/\/.*@/, "//***@"),
                  database: DATABASE_NAME,
                  suggestion: "Please verify MongoDB is running and the connection settings are correct",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      try {
        switch (request.params.name) {
        case "mongodb_query": {
          const { collection, filter, projection, sort, limit, skip } = request.params.arguments as {
            collection: string;
            filter?: string;
            projection?: string;
            sort?: string;
            limit?: number;
            skip?: number;
          };

          const coll = this.db!.collection(collection);
          
          const filterObj = filter ? JSON.parse(filter) : {};
          const projectionObj = projection ? JSON.parse(projection) : undefined;
          const sortObj = sort ? JSON.parse(sort) : undefined;

          const results = await coll
            .find(filterObj, { projection: projectionObj })
            .sort(sortObj || {})
            .skip(skip || 0)
            .limit(limit || 100)
            .toArray();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    collection,
                    count: results.length,
                    results,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_count": {
          const { collection, filter } = request.params.arguments as {
            collection: string;
            filter?: string;
          };

          const coll = this.db!.collection(collection);
          const filterObj = filter ? JSON.parse(filter) : {};
          const count = await coll.countDocuments(filterObj);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    collection,
                    filter: filterObj,
                    count,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_aggregate": {
          const { collection, pipeline } = request.params.arguments as {
            collection: string;
            pipeline: string;
          };

          const coll = this.db!.collection(collection);
          const pipelineObj = JSON.parse(pipeline);
          const results = await coll.aggregate(pipelineObj).toArray();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    collection,
                    pipeline: pipelineObj,
                    results,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_distinct": {
          const { collection, field, filter } = request.params.arguments as {
            collection: string;
            field: string;
            filter?: string;
          };

          const coll = this.db!.collection(collection);
          const filterObj = filter ? JSON.parse(filter) : {};
          const values = await coll.distinct(field, filterObj);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    collection,
                    field,
                    distinctValues: values,
                    count: values.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_list_databases": {
          const adminDb = this.client!.db().admin();
          const { databases } = await adminDb.listDatabases();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    currentDatabase: DATABASE_NAME,
                    connectionUri: MONGODB_URI.replace(/\/\/.*@/, "//***@"), // Hide credentials
                    databases: databases.map(db => ({
                      name: db.name,
                      sizeOnDisk: db.sizeOnDisk,
                      empty: db.empty,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_list_collections": {
          const { database } = request.params.arguments as {
            database?: string;
          };

          const targetDb = database ? this.client!.db(database) : this.db!;
          const collections = await targetDb.listCollections().toArray();
          
          // Get detailed stats for each collection
          const collectionStats = await Promise.all(
            collections.map(async (col) => {
              try {
                const stats = await targetDb.command({ collStats: col.name });
                return {
                  name: col.name,
                  type: col.type,
                  count: stats.count || 0,
                  size: stats.size || 0,
                  avgObjSize: stats.avgObjSize || 0,
                };
              } catch (error) {
                return {
                  name: col.name,
                  type: col.type,
                  error: "Could not retrieve stats",
                };
              }
            })
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    database: database || DATABASE_NAME,
                    totalCollections: collections.length,
                    collections: collectionStats,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "mongodb_verify_connection": {
          const serverStatus = await this.db!.admin().serverStatus();
          const dbStats = await this.db!.stats();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    connected: true,
                    connectionUri: MONGODB_URI.replace(/\/\/.*@/, "//***@"),
                    currentDatabase: DATABASE_NAME,
                    serverInfo: {
                      version: serverStatus.version,
                      uptime: serverStatus.uptime,
                      host: serverStatus.host,
                    },
                    databaseStats: {
                      collections: dbStats.collections,
                      dataSize: dbStats.dataSize,
                      storageSize: dbStats.storageSize,
                      indexes: dbStats.indexes,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Tool Execution Failed",
                  tool: request.params.name,
                  message: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private inferSchema(documents: any[]): Record<string, any> {
    if (documents.length === 0) return {};

    const schema: Record<string, any> = {};

    documents.forEach((doc) => {
      Object.keys(doc).forEach((key) => {
        const value = doc[key];
        const type = Array.isArray(value)
          ? "array"
          : value === null
          ? "null"
          : typeof value === "object"
          ? "object"
          : typeof value;

        if (!schema[key]) {
          schema[key] = { type, examples: [] };
        }

        if (schema[key].examples.length < 3 && value !== null && value !== undefined) {
          schema[key].examples.push(value);
        }
      });
    });

    return schema;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MongoDB MCP server running on stdio");
  }
}

// Start the server
const server = new MongoDBMCPServer();
server.run().catch(console.error);
