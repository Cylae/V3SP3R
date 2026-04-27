const { performance } = require('perf_hooks');

const ITERATIONS = 1000000;

function benchOld(rawText) {
  const wakePatterns = [
    /^hey\s+vesper[\s,.:!]*(.*)$/i,
    /^vesper[\s,.:!]*(.*)$/i,
  ];

  let command = null;
  let isWakeTriggered = false;

  for (const pattern of wakePatterns) {
    const match = rawText.match(pattern);
    if (match) {
      isWakeTriggered = true;
      command = match[1]?.trim() || null;
      break;
    }
  }
  return { isWakeTriggered, command };
}

function benchNew(rawText) {
  // A single regex pattern instead of two.
  // Using an optional capture group or simply making 'hey\s+' optional:
  const wakePattern = /^(?:hey\s+)?vesper[\s,.:!]*(.*)$/i;

  let command = null;
  let isWakeTriggered = false;

  const match = rawText.match(wakePattern);
  if (match) {
    isWakeTriggered = true;
    command = match[1]?.trim() || null;
  }
  return { isWakeTriggered, command };
}

function runBenchmark(text) {
  console.log(`\nBenchmarking with text: "${text}"`);

  const startOld = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    benchOld(text);
  }
  const endOld = performance.now();

  const startNew = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    benchNew(text);
  }
  const endNew = performance.now();

  const timeOld = endOld - startOld;
  const timeNew = endNew - startNew;

  console.log(`Old implementation: ${timeOld.toFixed(2)} ms`);
  console.log(`New implementation: ${timeNew.toFixed(2)} ms`);
  console.log(`Improvement: ${((timeOld - timeNew) / timeOld * 100).toFixed(2)}%`);
}

runBenchmark("hey vesper, turn on the lights");
runBenchmark("vesper turn off the lights");
runBenchmark("hello world, not a wake word");

// Verify correctness
console.log("\nCorrectness checks:");
const testCases = [
  "hey vesper, turn on the lights",
  "vesper turn off the lights",
  "hey vesper",
  "vesper",
  "Hey Vesper scan this",
  "hello world",
  "vespertine", // regex \b?
];

for (const text of testCases) {
  const r1 = benchOld(text);
  const r2 = benchNew(text);
  if (r1.isWakeTriggered !== r2.isWakeTriggered || r1.command !== r2.command) {
    console.error(`Mismatch for "${text}": Old = ${JSON.stringify(r1)}, New = ${JSON.stringify(r2)}`);
  } else {
    console.log(`Match for "${text}": ${JSON.stringify(r1)}`);
  }
}
