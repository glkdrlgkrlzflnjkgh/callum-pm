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