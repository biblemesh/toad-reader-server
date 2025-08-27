export default {
  preset: 'ts-jest',
  maxWorkers: 3,
  modulePathIgnorePatterns: ['crons'],
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.test.{ts,js}',
    '!src/**/*.d.ts',
  ],
  clearMocks: true,
  restoreMocks: true,
  roots: ['<rootDir>/src'],
  modulePaths: ['<rootDir>/src'],
};
