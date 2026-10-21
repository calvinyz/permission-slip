/**
 * Enrollment values for the local demo (npm run demo:local) and the scenario runner's defaults.
 * They only work against a service bound to 127.0.0.1, so fixed values are fine here; real
 * deployments set their own in .env.
 */
export const DEMO_ENROLLMENT: Record<string, string> = {
  INSTINCT_NUMBER_MAYA: "+15550000001",
  MUSE_NUMBER_DEV: "+15550000002",
  MUSE_EMAIL_DEV: "muse-dev@example.com",
  MCP_TOKEN_CLAUDE_DEV: "local_demo_claude_dev_0000000000",
  MCP_TOKEN_CHATGPT_DEV: "local_demo_chatgpt_dev_000000000",
  MCP_TOKEN_CLAUDE_MAYA: "local_demo_claude_maya_000000000",
};
