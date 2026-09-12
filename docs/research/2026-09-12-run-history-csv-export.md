# Run history CSV export research

The run history surface already loads a bounded page and can export a typed JSON packet. A CSV view
adds practical spreadsheet interoperability for the harness brief's price and heterogeneous-agent
comparisons while reusing the same loaded rows. The serializer escapes all cells and caps rows at the
existing export bound.

The CSV deliberately contains telemetry and identity labels only: status, duration, token counts,
estimated cost, budget flag, agent harness/model, and timestamps. It omits transcript content, user
prompts, task titles, and raw errors. The browser creates the file locally, so no new server endpoint
or secret-bearing persistence path is introduced.
