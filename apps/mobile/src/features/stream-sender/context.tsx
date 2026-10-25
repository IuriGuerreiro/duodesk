import { createContext, useContext, type ReactNode } from "react";
import { useSenderSession } from "./use-sender-session";

const SessionContext = createContext<ReturnType<
  typeof useSenderSession
> | null>(null);

export function SenderSessionProvider({ children }: { children: ReactNode }) {
  const session = useSenderSession();
  return <SessionContext value={session}>{children}</SessionContext>;
}

export function useSharedSenderSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("SenderSessionProvider is required.");
  return session;
}
