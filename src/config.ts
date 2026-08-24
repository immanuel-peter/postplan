function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type AppConfig = {
  nodeEnv: string;
  port: number;
  baseDomain: string;
  databaseUrl: string;
  s3EndpointUrl: string;
  s3Region: string;
  s3Bucket: string;
  s3AddressingStyle: "path" | "virtual";
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  tokenPepper: string;
  bootstrapToken: string;
  openapiPublic: boolean;
};

export function loadConfig(): AppConfig {
  const addressing = optional("S3_ADDRESSING_STYLE", "path");
  if (addressing !== "path" && addressing !== "virtual") {
    throw new Error("S3_ADDRESSING_STYLE must be path or virtual");
  }

  return {
    nodeEnv: optional("NODE_ENV", "production"),
    port: Number.parseInt(optional("PORT", "3000"), 10),
    baseDomain: optional("BASE_DOMAIN", "postplan.domain"),
    databaseUrl: required("DATABASE_URL"),
    s3EndpointUrl: required("S3_ENDPOINT_URL"),
    s3Region: optional("S3_REGION", "garage"),
    s3Bucket: optional("S3_BUCKET", "postplan"),
    s3AddressingStyle: addressing,
    s3AccessKeyId: required("S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    tokenPepper: required("TOKEN_PEPPER"),
    bootstrapToken: required("BOOTSTRAP_TOKEN"),
    openapiPublic: optional("OPENAPI_PUBLIC", "true") === "true",
  };
}
