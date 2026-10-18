import { ClerkProvider } from "@clerk/nextjs";
import { isClerkConfigured } from "../../lib/clerk-config";
import "../(auth)/auth.css";

export default function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return isClerkConfigured() ? <ClerkProvider>{children}</ClerkProvider> : children;
}
