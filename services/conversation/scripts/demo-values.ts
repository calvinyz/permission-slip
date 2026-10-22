/**
 * Enrollment values for the local demo (npm run demo:local) and the scenario runner's defaults.
 * They only work against a service bound to 127.0.0.1, so fixed values are fine here; real
 * deployments set their own in .env.
 */
export const DEMO_ENROLLMENT: Record<string, string> = {
  MUSE_NUMBER_MAYA: "+15550000001",
  INSTINCT_NUMBER_NOAH: "+15550000002",
  MUSE_EMAIL_MAYA: "muse-maya@example.com",
  MCP_TOKEN_CLAUDE_NOAH: "local_demo_claude_noah_0000000000",
  MCP_TOKEN_CHATGPT_MAYA: "local_demo_chatgpt_maya_000000000",
  MCP_TOKEN_CLAUDE_MAYA: "local_demo_claude_maya_000000000",
};
