// Pi shows these lines to users after `pi update`, so they carry only the changeset text, without commit hashes.
export default {
  getReleaseLine: async (changeset: { summary: string }) => {
    const [firstLine, ...futureLines] = changeset.summary
      .split("\n")
      .map((line) => line.trimEnd());
    return [
      `- ${firstLine}`,
      ...futureLines.map((line) => (line ? `  ${line}` : "")),
    ].join("\n");
  },
  getDependencyReleaseLine: async () => "",
};
