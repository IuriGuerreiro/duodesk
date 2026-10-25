import { createContext, useContext, type ReactNode } from "react";
import { useSenderSession } from "./use-sender-session";

const SenderContext = createContext<
  ReturnType<typeof useSenderSession> | undefined
>(undefined);

/** Owns the connection across Home, Scan and manual-entry routes. */
export function SenderSessionProvider({ children }: { children: ReactNode }) {
  const connection = useSenderSession();
  return (
    <SenderContext.Provider value={connection}>
      {children}
    </SenderContext.Provider>
  );
}

export function useSenderConnection() {
  const connection = useContext(SenderContext);
  if (!connection)
    throw new Error("Sender screens require SenderSessionProvider");
  return connection;
}
