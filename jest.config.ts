import type { Config } from 'jest';

const config: Config = {
  maxWorkers: 3,
  modulePathIgnorePatterns: ['crons'],
};

export default config;
