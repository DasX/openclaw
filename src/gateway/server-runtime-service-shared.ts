// Shared Gateway runtime service helpers.
// Supplies minimal service handles for tests and reduced startup paths.
export type SessionServices = { stop: () => void };

export type GatewayRuntimeServiceLogger = {
  child: (name: string) => {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  error: (message: string) => void;
};

/** Stop-safe placeholder until the session background services are started. */
export function createNoopSessionServices(): SessionServices {
  return {
    stop: () => {},
  };
}
