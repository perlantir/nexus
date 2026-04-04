# Contributing to DeciGraph

Thank you for your interest in contributing to DeciGraph. This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker and Docker Compose
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/DeciGraph.git
cd decigraph

# Install dependencies
pnpm install

# Start the database
docker compose up -d postgres

# Build all packages
pnpm build

# Run tests
pnpm test

# Start the development server
pnpm --filter @decigraph/server dev
```

## Project Structure

```
packages/
  core/       — Decision graph, context compiler, change propagator, distillery, temporal engine
  server/     — Hono REST API (33 endpoints)
  sdk/        — TypeScript client library
  mcp/        — MCP server for AI agents (Claude, Cursor, etc.)
  dashboard/  — React + D3.js web UI
  cli/        — Command-line interface

integrations/
  langchain/       — LangChain/LangGraph adapter
  crewai/          — CrewAI adapter
  autogen/         — Microsoft AutoGen adapter
  openai-agents/   — OpenAI Agents SDK adapter

python-sdk/   — Python REST client (shared by all integrations)
```

## Submitting Changes

### Branch Naming

- `feat/description` for new features
- `fix/description` for bug fixes
- `docs/description` for documentation
- `test/description` for test additions

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add WebSocket support for real-time notifications
fix: correct freshness scoring for validated decisions
docs: update MCP setup guide for Cursor
test: add integration tests for context compiler
chore: update dependencies
```

### Pull Request Process

1. Fork the repository and create your branch from `main`
2. Write or update tests for your changes
3. Ensure all tests pass: `pnpm test`
4. Ensure TypeScript compiles: `pnpm build`
5. Update documentation if your changes affect public APIs
6. Submit your PR with a clear description of the changes

## Code Style

- TypeScript strict mode, ES2022 target
- All imports use `.js` extensions (NodeNext module resolution)
- Prettier for formatting: `pnpm format`
- ESLint for linting: `pnpm lint`

## Testing

- Unit tests with Vitest
- Test files go in `tests/` directories adjacent to source
- Name test files `*.test.ts`
- Run all tests: `pnpm test`
- Run specific package tests: `pnpm --filter @decigraph/core test`

## Reporting Issues

Use [GitHub Issues](../../issues) with the provided templates:

- **Bug reports**: Include steps to reproduce, expected vs actual behavior, and your environment
- **Feature requests**: Describe the use case and proposed solution

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
