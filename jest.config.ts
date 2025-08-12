export default {
  preset: 'ts-jest',
  maxWorkers: 3,
  modulePathIgnorePatterns: ['crons'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.test.{ts,js}',
    '!src/**/*.d.ts',
    '!__tests__/**',
  ],
  clearMocks: true,
  restoreMocks: true,
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  modulePaths: ['<rootDir>/src'],
};
