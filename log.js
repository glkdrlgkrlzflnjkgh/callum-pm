import chalk from "chalk";

export function info(msg) {
  console.log(chalk.blue("INFO: ") + msg);
}

export function step(msg) {
  console.log(chalk.green("STEP: ") + msg);
}

export function error(msg) {
  console.error(chalk.red("ERROR! ") + msg);
}

export function fmt(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => vars[key]);
}

export function fail(msg) {
  error(msg);
  process.exit(1);
}