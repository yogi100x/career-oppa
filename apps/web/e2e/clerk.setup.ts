import { test as setup } from "@playwright/test";
import { clerkSetup } from "@clerk/testing/playwright";

setup.describe.configure({ mode: "serial" });

setup("prepare Clerk testing token", async () => {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    throw new Error("Clerk development keys are required to run browser tests.");
  }
  await clerkSetup();
});
