process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
process.stdout.write("ready\n");
