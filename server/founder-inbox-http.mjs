export async function handleFounderInbox(req, res, inbox) {
  const respond = (status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(data));
  };

  if (req.method === "GET") {
    return respond(200, {
      tasks: inbox.list(),
      executionEnabled: false
    });
  }

  if (req.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (
    !String(req.headers["content-type"] || "")
      .toLowerCase().startsWith("application/json")
  ) {
    return respond(415, { error: "JSON required" });
  }

  try {
    const chunks = [];
    let bytes = 0;

    for await (const chunk of req) {
      bytes += chunk.length;

      if (bytes > 100000) {
        return respond(413, { error: "Request too large" });
      }

      chunks.push(chunk);
    }

    const input = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );

    const task = inbox.submit(input);

    return respond(200, {
      task,
      executionEnabled: false,
      message: "Saved locally. Agent execution is not enabled."
    });
  } catch (error) {
    const known = [
      "Invalid founder task",
      "Request ID already used for different work"
    ];

    return respond(
      known.includes(error.message) ? 400 : 500,
      {
        error: known.includes(error.message)
          ? error.message
          : "Unable to save founder task"
      }
    );
  }
}
