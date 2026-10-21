import { ReceiverWorkspace, useReceiverSession } from "@/features/receiver";
import "./App.css";

export default function App() {
  return <ReceiverWorkspace {...useReceiverSession()} />;
}
