export const serializeArguments = (args: string[]): string =>
  args
    .map((arg) => {
      // Quote when whitespace or shell metacharacters would be misparsed on round-trip.
      if (!/[\s\\"']/.test(arg)) return arg;
      return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(' ');
