import type { SafetyProvider, ToolPlugin } from '../../contracts/src/index.js';
import type { State } from './state.js';

/** Core enforces declared effects and the active provider, never concrete plugin names. */
export function availableTools(
  state: State,
  tools: ToolPlugin[],
  safety: SafetyProvider,
) {
  const config = state.config;
  const enforced =
    config.safety.mode === 'enforce' &&
    !config.disabledPlugins.includes(safety.id);
  return tools.filter(
    (tool) =>
      (tool.effect === 'read' || enforced) &&
      (!tool.pluginId || !config.disabledPlugins.includes(tool.pluginId)) &&
      (tool.available?.() ?? true),
  );
}
