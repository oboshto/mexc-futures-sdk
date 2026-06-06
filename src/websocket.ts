import WebSocket from "ws";
import { EventEmitter } from "events";
import * as crypto from "crypto";
import { Logger, LogLevelString } from "./utils/logger";

export interface WebSocketConfig {
  apiKey: string; // API Key from MEXC API management
  secretKey: string; // Secret Key from MEXC API management (needed for HMAC signature)
  autoReconnect?: boolean;
  reconnectInterval?: number;
  pingInterval?: number;
  logLevel?: LogLevelString;
}

export interface LoginParams {
  apiKey: string;
  signature: string;
  reqTime: string;
  subscribe?: boolean; // false to cancel default push
}

export interface FilterParams {
  filters?: Array<{
    filter:
      | "order"
      | "order.deal"
      | "position"
      | "plan.order"
      | "stop.order"
      | "stop.planorder"
      | "risk.limit"
      | "adl.level"
      | "asset";
    rules?: string[]; // symbol rules for filtering
  }>;
}

export type KLineInterval =
  | "Min1"
  | "Min5"
  | "Min15"
  | "Min30"
  | "Min60"
  | "Hour4"
  | "Hour8"
  | "Day1"
  | "Week1"
  | "Month1";

export interface WebSocketMessage {
  method?: string;
  channel?: string;
  data?: any;
  param?: any;
  subscribe?: boolean;
  gzip?: boolean;
}

export class MexcFuturesWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isLoggedIn = false;
  private readonly wsUrl = "wss://contract.mexc.com/edge";
  private logger: Logger;

  constructor(config: WebSocketConfig) {
    super();
    this.config = {
      autoReconnect: true,
      reconnectInterval: 5000,
      pingInterval: 15000, // 15 seconds (recommended 10-20s)
      ...config,
    };
    this.logger = new Logger(config.logLevel);
  }

  /**
   * Connect to WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.logger.info("🔌 Connecting to MEXC Futures WebSocket...");
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on("open", () => {
          this.logger.info("✅ WebSocket connected");
          this.isConnected = true;
          this.startPing();
          this.emit("connected");
          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            this.logger.error("❌ Error parsing WebSocket message:", error);
            this.emit("error", error);
          }
        });

        this.ws.on("close", (code: number, reason: string) => {
          this.logger.warn(`🔌 WebSocket closed: ${code} ${reason}`);
          this.isConnected = false;
          this.isLoggedIn = false;
          this.stopPing();
          this.emit("disconnected", { code, reason });

          if (this.config.autoReconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (error: Error) => {
          this.logger.error("❌ WebSocket error:", error);
          this.emit("error", error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.logger.info("🔌 Disconnecting WebSocket...");
    this.config.autoReconnect = false;
    this.stopPing();
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isLoggedIn = false;
  }

  /**
   * Login to access private data streams
   * @param subscribe - false to cancel default push of all private data
   */
  async login(subscribe: boolean = true): Promise<void> {
    if (!this.isConnected) {
      throw new Error("WebSocket not connected");
    }

    // Generate signature for login using API Key and Secret Key
    const reqTime = Date.now().toString();

    // For WebSocket, signature is HMAC SHA256 of (apiKey + timestamp) using secret key
    const signatureString = `${this.config.apiKey}${reqTime}`;
    const signature = crypto
      .createHmac("sha256", this.config.secretKey)
      .update(signatureString)
      .digest("hex");

    const loginMessage: WebSocketMessage = {
      subscribe,
      method: "login",
      param: {
        apiKey: this.config.apiKey,
        signature: signature,
        reqTime,
      },
    };

    this.send(loginMessage);
  }

  /**
   * Set personal data filters
   * @param filters - Array of filters to apply
   */
  setPersonalFilter(filters?: FilterParams["filters"]): void {
    if (!this.isLoggedIn) {
      throw new Error("Must login first before setting filters");
    }

    const filterMessage: WebSocketMessage = {
      method: "personal.filter",
      param: {
        filters: filters || [], // Empty array means all data
      },
    };

    this.send(filterMessage);
  }

  // ==================== PRIVATE DATA SUBSCRIPTIONS ====================

  /**
   * Subscribe to specific order updates for symbols
   */
  subscribeToOrders(symbols?: string[]): void {
    this.setPersonalFilter([
      {
        filter: "order",
        rules: symbols,
      },
    ]);
  }

  /**
   * Subscribe to order deals (executions) for symbols
   */
  subscribeToOrderDeals(symbols?: string[]): void {
    this.setPersonalFilter([
      {
        filter: "order.deal",
        rules: symbols,
      },
    ]);
  }

  /**
   * Subscribe to position updates for symbols
   */
  subscribeToPositions(symbols?: string[]): void {
    this.setPersonalFilter([
      {
        filter: "position",
        rules: symbols,
      },
    ]);
  }

  /**
   * Subscribe to asset (balance) updates
   */
  subscribeToAssets(): void {
    this.setPersonalFilter([
      {
        filter: "asset",
      },
    ]);
  }

  /**
   * Subscribe to ADL level updates
   */
  subscribeToADLLevels(): void {
    this.setPersonalFilter([
      {
        filter: "adl.level",
      },
    ]);
  }

  /**
   * Subscribe to multiple data types with custom filters
   */
  subscribeToMultiple(filters: FilterParams["filters"]): void {
    this.setPersonalFilter(filters);
  }

  /**
   * Subscribe to all private data (default after login)
   */
  subscribeToAll(): void {
    this.setPersonalFilter([]);
  }

  // ==================== PUBLIC DATA SUBSCRIPTIONS ====================

  /**
   * Subscribe to all tickers (all contracts)
   * @param gzip - Whether to compress the data (default: false)
   */
  subscribeToAllTickers(gzip: boolean = false): void {
    const message: WebSocketMessage = {
      method: "sub.tickers",
      param: {},
      gzip,
    };
    this.send(message);
  }

  /**
   * Unsubscribe from all tickers
   */
  unsubscribeFromAllTickers(): void {
    const message: WebSocketMessage = {
      method: "unsub.tickers",
      param: {},
    };
    this.send(message);
  }

  /**
   * Subscribe to ticker for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  subscribeToTicker(symbol: string): void {
    const message: WebSocketMessage = {
      method: "sub.ticker",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from ticker for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromTicker(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.ticker",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to trades for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  subscribeToDeals(symbol: string): void {
    const message: WebSocketMessage = {
      method: "sub.deal",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from trades for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromDeals(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.deal",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to incremental depth for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   * @param compress - Whether to compress the data (default: false)
   */
  subscribeToDepth(symbol: string, compress: boolean = false): void {
    const message: WebSocketMessage = {
      method: "sub.depth",
      param: {
        symbol,
        compress,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to full depth for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   * @param limit - Depth limit (5, 10, or 20)
   */
  subscribeToFullDepth(symbol: string, limit: 5 | 10 | 20 = 20): void {
    const message: WebSocketMessage = {
      method: "sub.depth.full",
      param: {
        symbol,
        limit,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from incremental depth for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromDepth(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.depth",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from full depth for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromFullDepth(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.depth.full",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to kline/candlestick data for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   * @param interval - Kline interval
   */
  subscribeToKline(symbol: string, interval: KLineInterval): void {
    const message: WebSocketMessage = {
      method: "sub.kline",
      param: {
        symbol,
        interval,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from kline/candlestick data for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromKline(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.kline",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to funding rate for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  subscribeToFundingRate(symbol: string): void {
    const message: WebSocketMessage = {
      method: "sub.funding.rate",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from funding rate for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromFundingRate(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.funding.rate",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to index price for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  subscribeToIndexPrice(symbol: string): void {
    const message: WebSocketMessage = {
      method: "sub.index.price",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from index price for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromIndexPrice(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.index.price",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Subscribe to fair price for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  subscribeToFairPrice(symbol: string): void {
    const message: WebSocketMessage = {
      method: "sub.fair.price",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Unsubscribe from fair price for specific contract
   * @param symbol - Contract symbol (e.g., "BTC_USDT")
   */
  unsubscribeFromFairPrice(symbol: string): void {
    const message: WebSocketMessage = {
      method: "unsub.fair.price",
      param: {
        symbol,
      },
    };
    this.send(message);
  }

  /**
   * Send message to WebSocket
   */
  private send(message: WebSocketMessage): void {
    if (this.ws && this.isConnected) {
      const messageString = JSON.stringify(message);
      // Never log credentials: the `login` message carries the API key + HMAC signature.
      const logSafe =
        (message as any)?.method === "login"
          ? JSON.stringify({ ...message, param: "[REDACTED]" })
          : messageString;
      this.logger.debug("➡️ Sending WebSocket message:", logSafe);
      this.ws.send(messageString);
    } else {
      this.logger.error(
        "❌ Cannot send message: WebSocket not connected or not ready"
      );
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WebSocketMessage): void {
    this.logger.debug(
      "⬅️ Received WebSocket message:",
      JSON.stringify(message)
    );

    // DEBUG: Uncomment next line for detailed message debugging
    // console.log("🔍 RAW MESSAGE:", JSON.stringify(message, null, 2));

    // Handle pong response
    if (message.channel === "pong") {
      this.emit("pong", message.data);
      return;
    }

    // Handle login response
    if (message.channel === "rs.login") {
      if (message.data === "success" || message.data?.code === 0) {
        this.isLoggedIn = true;
        this.logger.info("✅ WebSocket login successful");
        this.emit("login", message);
      } else {
        this.isLoggedIn = false;
        this.logger.error("❌ WebSocket login failed:", message.data);
        this.emit("login_failed", message.data);
      }
      return;
    }

    // Handle filter response
    if (message.channel === "rs.personal.filter") {
      if (message.data === "success" || message.data?.code === 0) {
        this.logger.info("✅ WebSocket filter set successfully");
        this.emit("filter_set", message.data);
      } else {
        this.logger.error("❌ WebSocket filter set failed:", message.data);
        this.emit("filter_failed", message.data);
      }
      return;
    }

    // Handle subscription confirmations
    if (message.channel?.startsWith("rs.sub.")) {
      const streamType = message.channel.replace("rs.sub.", "");
      this.logger.info(`✅ Subscribed to ${streamType}`);
      this.emit("subscribed", { type: streamType, data: message.data });
      return;
    }

    // Handle unsubscription confirmations
    if (message.channel?.startsWith("rs.unsub.")) {
      const streamType = message.channel.replace("rs.unsub.", "");
      this.logger.info(`✅ Unsubscribed from ${streamType}`);
      this.emit("unsubscribed", { type: streamType, data: message.data });
      return;
    }

    // Handle error responses
    if (message.channel === "rs.error") {
      this.logger.error("❌ WebSocket error response:", message.data);
      this.emit("error", new Error(message.data));
      return;
    }

    // Handle private data updates
    this.handleDataUpdate(message);
  }

  /**
   * Handle data updates (orders, positions, market data, etc.)
   */
  private handleDataUpdate(message: WebSocketMessage): void {
    const { channel, data } = message;

    // Handle public data updates
    switch (channel) {
      case "push.tickers":
        this.emit("tickers", data);
        break;
      case "push.ticker":
        this.emit("ticker", data);
        break;
      case "push.deal":
        this.emit("deal", data);
        break;
      case "push.depth":
        this.emit("depth", data);
        break;
      case "push.kline":
        this.emit("kline", data);
        break;
      case "push.funding.rate":
        this.emit("fundingRate", data);
        break;
      case "push.index.price":
        this.emit("indexPrice", data);
        break;
      case "push.fair.price":
        this.emit("fairPrice", data);
        break;

      // Handle private data updates with push.personal.* channels
      case "push.personal.order":
        this.emit("orderUpdate", data);
        break;
      case "push.personal.order.deal":
        this.emit("orderDeal", data);
        break;
      case "push.personal.position":
        this.emit("positionUpdate", data);
        break;
      case "push.personal.asset":
        this.emit("assetUpdate", data);
        break;
      case "push.personal.stop.order":
        this.emit("stopOrder", data);
        break;
      case "push.personal.stop.planorder":
        this.emit("stopPlanOrder", data);
        break;
      case "push.personal.liquidate.risk":
        this.emit("liquidateRisk", data);
        break;
      case "push.personal.adl.level":
        this.emit("adlLevel", data);
        break;
      case "push.personal.risk.limit":
        this.emit("riskLimit", data);
        break;
      case "push.personal.plan.order":
        this.emit("planOrder", data);
        break;

      default:
        // If not handled by any case above, emit as generic message
        // Uncomment for debugging unhandled messages
        // console.log("📥 Other message detected:", JSON.stringify(message, null, 2));
        this.emit("message", message);
        break;
    }
  }

  /**
   * Start ping timer
   */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected) {
        this.logger.debug("➡️ Sending ping");
        this.send({ method: "ping" });
      }
    }, this.config.pingInterval);
  }

  /**
   * Stop ping timer
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.logger.debug("⏹️ Stopped ping timer");
    }
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.logger.info(
      `🔌 Scheduling reconnect in ${this.config.reconnectInterval}ms...`
    );
    this.reconnectTimer = setTimeout(() => {
      this.logger.info("🔌 Reconnecting...");
      this.connect().catch((error) => {
        this.logger.error("❌ Reconnect failed:", error);
      });
    }, this.config.reconnectInterval);
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Get connection status
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Get login status
   */
  get loggedIn(): boolean {
    return this.isLoggedIn;
  }
}
