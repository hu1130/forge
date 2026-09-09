import path from "node:path";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export interface DeepSeekSettings {
  configured: boolean;
  baseUrl: string;
  model: string;
}

export function deepSeekSettings(environment: NodeJS.ProcessEnv = process.env): DeepSeekSettings {
  return {
    configured: Boolean(environment.DEEPSEEK_API_KEY?.trim()),
    baseUrl: environment.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL,
    model: environment.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
  };
}

const tomlString = (value: string) => JSON.stringify(value);

export function deepSeekAppServerArgs(settings: DeepSeekSettings) {
  const catalogPath = path.resolve(import.meta.dirname, "../resources/deepseek-models.json").replaceAll("\\", "/");
  return [
    "-c", `model=${tomlString(settings.model)}`,
    "-c", 'model_provider="deepseek"',
    "-c", 'preferred_auth_method="apikey"',
    "-c", 'forced_login_method="api"',
    "-c", 'model_reasoning_effort="high"',
    "-c", `model_catalog_json=${tomlString(catalogPath)}`,
    "-c", 'model_providers.deepseek.name="DeepSeek"',
    "-c", `model_providers.deepseek.base_url=${tomlString(settings.baseUrl)}`,
    "-c", 'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"',
    "-c", 'model_providers.deepseek.wire_api="responses"',
  ];
}
