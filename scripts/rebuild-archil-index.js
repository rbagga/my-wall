#!/usr/bin/env node

const { rebuildEntrySummaryIndex } = require('../api/lib/archil-db');

rebuildEntrySummaryIndex()
  .then((rows) => console.log(`Indexed ${rows.length} entries.`))
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
