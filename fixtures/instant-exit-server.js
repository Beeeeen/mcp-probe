#!/usr/bin/env node
/**
 * Exits before reading anything. Models the very common case of a server that
 * dies on startup -- a missing environment variable, a failed database
 * connection, a bad config path.
 *
 * Every write mcp-probe makes to this process lands on a closed pipe. Node
 * surfaces that as EPIPE on the stream, and without an error listener it
 * becomes an uncaught exception that would take mcp-probe down instead of
 * reporting the dead server.
 */
process.stderr.write('fatal: DATABASE_URL is not set\n')
process.exit(1)
