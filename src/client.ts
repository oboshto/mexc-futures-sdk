import axios, { AxiosInstance } from "axios";
import { ENDPOINTS } from "./utils/constants";
import { generateHeaders } from "./utils/headers";
import { Logger, LogLevelString } from "./utils/logger";
import {
  MexcValidationError,
  parseAxiosError,
  formatErrorForLogging,
} from "./utils/errors";
import {
  OrderHistoryParams,
  OrderHistoryResponse,
  OrderDealsParams,
  OrderDealsResponse,
  CancelOrderResponse,
  CancelOrderByExternalIdRequest,
  CancelOrderByExternalIdResponse,
  CancelAllOrdersRequest,
  CancelAllOrdersResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
  GetOrderResponse,
} from "./types/orders";
import {
  RiskLimit,
  FeeRate,
  AccountResponse,
  AccountAssetResponse,
  OpenPositionsResponse,
  PositionHistoryParams,
  PositionHistoryResponse,
} from "./types/account";
import {
  TickerResponse,
  ContractDetailResponse,
  ContractDepthResponse,
} from "./types/market";
import JSONBigInt from "json-bigint";

// Big-int-safe + prototype-pollution-hardened JSON parser for HTTP responses.
// useNativeBigInt: ids > 2^53 become native `bigint` (matches the `number | bigint` types);
// protoAction/constructorAction "ignore": drop `__proto__`/`constructor` keys from untrusted responses.
const jsonBig = JSONBigInt({
  useNativeBigInt: true,
  protoAction: "ignore",
  constructorAction: "ignore",
});

export interface MexcFuturesSDKConfig {
  authToken: string; // WEB authentication key (starts with "WEB...")
  baseURL?: string;
  timeout?: number;
  userAgent?: string;
  customHeaders?: Record<string, string>;
  logLevel?: LogLevelString;
}

export class MexcFuturesSDK {
  private httpClient: AxiosInstance;
  private config: MexcFuturesSDKConfig;
  private logger: Logger;

  constructor(config: MexcFuturesSDKConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

    this.httpClient = axios.create({
      baseURL: config.baseURL || "https://futures.mexc.com/api/v1",
      timeout: config.timeout || 30000,
      headers: generateHeaders(config),
      // Parse responses with a big-int-safe JSON parser. MEXC order ids exceed
      // Number.MAX_SAFE_INTEGER (e.g. 817027833053397504), and the default JSON.parse
      // silently corrupts them (…397504 -> …397500). JSONBigInt preserves them as BigInt
      // so String(orderId) is exact; falls back to the raw string on non-JSON payloads.
      transformResponse: [
        (data) => {
          try {
            return jsonBig.parse(data);
          } catch {
            return data;
          }
        },
      ],
    });

    // Request interceptor for debugging
    this.httpClient.interceptors.request.use((requestConfig) => {
      this.logger.debug(
        `🌐 ${requestConfig.method?.toUpperCase()} ${requestConfig.baseURL}${
          requestConfig.url
        }`
      );
      if (requestConfig.data) {
        this.logger.debug(
          "📦 Request body:",
          JSON.stringify(requestConfig.data, null, 2)
        );
      }
      return requestConfig;
    });

    // Response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug(`✅ ${response.status} ${response.statusText}`);
        return response;
      },
      (error) => {
        // Parse the axios error into a user-friendly MEXC error
        const mexcError = parseAxiosError(
          error,
          error.config?.url,
          error.config?.method?.toUpperCase()
        );

        // Log the user-friendly error message
        this.logger.error(mexcError.getUserFriendlyMessage());

        // Log detailed error information in debug mode
        if (this.logger.isDebugEnabled()) {
          this.logger.debug(
            "Detailed error info:",
            formatErrorForLogging(mexcError)
          );
        }

        return Promise.reject(mexcError);
      }
    );
  }

  /**
   * Submit order using /api/v1/private/order/submit endpoint
   * This is the alternative order submission method used by MEXC browser
   */
  async submitOrder(
    orderParams: SubmitOrderRequest
  ): Promise<SubmitOrderResponse> {
    try {
      // Validate params BEFORE signing/sending — this is a live-money endpoint, so a NaN/0/undefined
      // field or a wrong enum must never reach the exchange as a signed order.
      const p = orderParams;
      if (!p || typeof p.symbol !== "string" || p.symbol.length === 0) {
        throw new MexcValidationError("symbol is required", "symbol");
      }
      if (!Number.isFinite(p.price) || p.price < 0) {
        throw new MexcValidationError("price must be a finite number >= 0", "price");
      }
      if (!Number.isFinite(p.vol) || p.vol <= 0) {
        throw new MexcValidationError("vol must be a finite number > 0", "vol");
      }
      if (![1, 2, 3, 4].includes(p.side as number)) {
        throw new MexcValidationError("side must be one of 1,2,3,4", "side");
      }
      if (![1, 2, 3, 4, 5, 6].includes(p.type as number)) {
        throw new MexcValidationError("type must be one of 1..6", "type");
      }
      if (![1, 2].includes(p.openType as number)) {
        throw new MexcValidationError("openType must be 1 (isolated) or 2 (cross)", "openType");
      }
      if (p.leverage !== undefined && (!Number.isFinite(p.leverage) || p.leverage <= 0)) {
        throw new MexcValidationError("leverage must be a finite number > 0", "leverage");
      }

      this.logger.info("🚀 Submitting order using /submit endpoint");

      this.logger.debug(
        "📦 Order parameters:",
        JSON.stringify(orderParams, null, 2)
      );

      // Generate headers with MEXC signature
      const headers = generateHeaders(
        {
          authToken: this.config.authToken,
          userAgent: this.config.userAgent,
          customHeaders: this.config.customHeaders,
        },
        true,
        orderParams
      );

      const response = await this.httpClient.post(
        ENDPOINTS.SUBMIT_ORDER,
        orderParams,
        {
          headers,
        }
      );

      this.logger.debug("🔍 Order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel orders by order IDs (up to 50 orders at once)
   */
  async cancelOrder(
    orderIds: Array<number | string | bigint>
  ): Promise<CancelOrderResponse> {
    try {
      if (orderIds.length === 0) {
        throw new MexcValidationError(
          "Order IDs array cannot be empty",
          "orderIds"
        );
      }
      if (orderIds.length > 50) {
        throw new MexcValidationError(
          "Cannot cancel more than 50 orders at once",
          "orderIds"
        );
      }

      // Serialize ids as strings: real MEXC order ids exceed 2^53 and cannot round-trip through a JS
      // number. Pass them through (string/bigint) and stringify so the signed body and the posted body
      // carry the exact id. The signature MUST be computed over the same payload that is sent.
      const ids = orderIds.map((id) => String(id));

      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        {
          authToken: this.config.authToken,
          userAgent: this.config.userAgent,
          customHeaders: this.config.customHeaders,
        },
        true,
        ids
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ORDER,
        ids,
        {
          headers,
        }
      );

      this.logger.debug("🔍 Cancel order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel order by external order ID
   */
  async cancelOrderByExternalId(
    params: CancelOrderByExternalIdRequest
  ): Promise<CancelOrderByExternalIdResponse> {
    try {
      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        {
          authToken: this.config.authToken,
          userAgent: this.config.userAgent,
          customHeaders: this.config.customHeaders,
        },
        true,
        params
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ORDER_BY_EXTERNAL_ID,
        params,
        {
          headers,
        }
      );

      this.logger.debug(
        "🔍 Cancel order by external ID response:",
        response.data
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Cancel all orders under a contract (or all orders if no symbol provided)
   */
  async cancelAllOrders(
    params?: CancelAllOrdersRequest
  ): Promise<CancelAllOrdersResponse> {
    try {
      const payload = params || {};

      // Generate headers with MEXC signature for POST request
      const headers = generateHeaders(
        {
          authToken: this.config.authToken,
          userAgent: this.config.userAgent,
          customHeaders: this.config.customHeaders,
        },
        true,
        payload
      );

      const response = await this.httpClient.post(
        ENDPOINTS.CANCEL_ALL_ORDERS,
        payload,
        {
          headers,
        }
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order history
   */
  async getOrderHistory(
    params: OrderHistoryParams
  ): Promise<OrderHistoryResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.ORDER_HISTORY, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get all transaction details of the user's orders
   */
  async getOrderDeals(params: OrderDealsParams): Promise<OrderDealsResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.ORDER_DEALS, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order information by order ID
   * @param orderId Order ID to query
   * @returns Detailed order information
   */
  async getOrder(
    orderId: number | string | bigint
  ): Promise<GetOrderResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.GET_ORDER}/${encodeURIComponent(String(orderId))}`
      );
      this.logger.debug("🔍 Order response:", response.data);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get order information by external order ID
   * @param symbol Contract symbol (e.g., "BTC_USDT")
   * @param externalOid External order ID
   * @returns Detailed order information
   */
  async getOrderByExternalId(
    symbol: string,
    externalOid: string
  ): Promise<GetOrderResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.GET_ORDER_BY_EXTERNAL_ID}/${encodeURIComponent(symbol)}/${encodeURIComponent(externalOid)}`
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get risk limits for account
   */
  async getRiskLimit(): Promise<AccountResponse<RiskLimit[]>> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.RISK_LIMIT);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get fee rates for contracts
   */
  async getFeeRate(): Promise<AccountResponse<FeeRate[]>> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.FEE_RATE);
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's single currency asset information
   * @param currency Currency symbol (e.g., "USDT", "BTC")
   * @returns Account asset information for the specified currency
   */
  async getAccountAsset(currency: string): Promise<AccountAssetResponse> {
    try {
      const response = await this.httpClient.get(
        `${ENDPOINTS.ACCOUNT_ASSET}/${encodeURIComponent(currency)}`
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's current holding positions
   * @param symbol Optional: specific contract symbol to filter positions
   * @returns List of open positions
   */
  async getOpenPositions(symbol?: string): Promise<OpenPositionsResponse> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.httpClient.get(ENDPOINTS.OPEN_POSITIONS, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get user's history position information
   * @param params Parameters for filtering position history
   * @returns List of historical positions
   */
  async getPositionHistory(
    params: PositionHistoryParams
  ): Promise<PositionHistoryResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.POSITION_HISTORY, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get ticker data for a specific symbol
   */
  async getTicker(symbol: string): Promise<TickerResponse> {
    try {
      const response = await this.httpClient.get(ENDPOINTS.TICKER, {
        params: { symbol },
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get contract information
   * @param symbol Optional: specific contract symbol (e.g., "BTC_USDT"). If not provided, returns all contracts
   * @returns Contract details for specified symbol or all contracts
   */
  async getContractDetail(symbol?: string): Promise<ContractDetailResponse> {
    try {
      const params = symbol ? { symbol } : {};
      const response = await this.httpClient.get(ENDPOINTS.CONTRACT_DETAIL, {
        params,
      });
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Get contract's depth information (order book)
   * @param symbol Contract symbol (e.g., "BTC_USDT")
   * @param limit Optional: depth tier limit
   * @returns Order book with bids and asks
   */
  async getContractDepth(
    symbol: string,
    limit?: number
  ): Promise<ContractDepthResponse> {
    try {
      const params = limit ? { limit } : {};
      const response = await this.httpClient.get(
        `${ENDPOINTS.CONTRACT_DEPTH}/${encodeURIComponent(symbol)}`,
        { params }
      );
      return response.data;
    } catch (error) {
      // Error is already logged by the interceptor with user-friendly message
      throw error;
    }
  }

  /**
   * Test connection to the API (using public endpoint)
   */
  async testConnection(): Promise<boolean> {
    try {
      // Test with a common symbol
      await this.getTicker("BTC_USDT");
      return true;
    } catch (error) {
      // Error is already logged by the interceptor, just return false
      return false;
    }
  }
}
