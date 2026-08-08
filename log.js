/*
MIT License

Copyright (c) 2026 callum and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import chalk from "chalk";
import readline from "node:readline";
export function info(msg) {
  console.log(chalk.blue.bold("INFO: ") + msg);
}

export function step(msg) {
  console.log(chalk.green.bold("STEP: ") + msg);
}

export function warn(msg) {
  console.warn(chalk.yellow.bold("WARN: ") + msg);
}

export function error(msg) {
  console.error(chalk.red.bold("ERROR: ") + msg);
}

export function debug(msg) {
  if (process.env.CALPM_DEBUG) {
    console.log(chalk.magenta.bold("DEBUG: ") + msg);
  }
}

export function fmt(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) =>
    key in vars ? vars[key] : '${' + key + '}'
  );
}

export function fail(msg) {
  error(msg);
  process.exit(1);
}

export async function question(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(chalk.cyan.bold("QUESTION: ") + msg + " ", answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}