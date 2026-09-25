# @mlflow/opencode

MLflow tracing plugin for [OpenCode](https://opencode.ai).

This plugin automatically traces OpenCode conversations to MLflow, capturing:

- User prompts and assistant responses
- LLM calls with token usage
- Tool invocations and results
- Session metadata

## Installation

```bash
npm install @mlflow/opencode
```

## Usage

1. Add to your `opencode.json`:

```json
{
  "plugin": ["@mlflow/opencode"]
}
```

2. Set environment variables:

```bash
export MLFLOW_TRACKING_URI=http://localhost:5000
export MLFLOW_EXPERIMENT_ID=123
```

3. Run OpenCode normally - traces are created automatically when sessions become idle.

> **OpenCode native OpenTelemetry:** do not enable `experimental.openTelemetry` alongside
> `@mlflow/opencode` unless you intentionally want both telemetry streams. The plugin creates
> its own LLM/tool spans; enabling OpenCode's native AI SDK telemetry as well can produce duplicate
> LLM spans and double-count token/cost metrics (for example both `gpt-5.6-terra` and
> `openai/gpt-5.6-terra`).

## Configuration

The plugin is configured via environment variables:

| Variable                | Required | Description                                                |
| ----------------------- | -------- | ---------------------------------------------------------- |
| `MLFLOW_TRACKING_URI`   | Yes      | MLflow tracking server URI (e.g., `http://localhost:5000`) |
| `MLFLOW_EXPERIMENT_ID`  | Yes      | MLflow experiment ID                                       |
| `MLFLOW_OPENCODE_DEBUG` | No       | Set to `true` to enable debug logging                      |

## Viewing Traces

Start an MLflow server and view your traces in the UI:

```bash
mlflow server
# Open http://localhost:5000
```

## License

Apache-2.0
