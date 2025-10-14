type TestFn = () => void | Promise<void>;

type TestCase = {
  name: string;
  fn: TestFn;
};

const tests: TestCase[] = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export function expect(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function expectEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but received ${String(actual)}`);
  }
}

export async function runAll(): Promise<void> {
  let passed = 0;
  const failures: Array<{ name: string; error: Error }> = [];

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.info(`✓ ${name}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failures.push({ name, error });
      console.error(`✗ ${name}: ${error.message}`);
    }
  }

  console.info(`\n${passed} / ${tests.length} tests passed`);

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${failure.error.stack ?? failure.error.message}`);
    }
    throw new Error(`${failures.length} test(s) failed`);
  }
}
