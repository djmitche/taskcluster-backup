let _ = require('lodash');
let Promise = require('bluebird');
let zstd = require('node-zstd');
let symbols = require('./symbols');
let es = require('event-stream');

module.exports = {
  run: async ({s3, azure, azureSAS, bucket, tables, concurrency}) => {
    console.log('Beginning restore.');

    symbols.setup();

    await Promise.map(tables, async (tableConf, index) => {
      let symbol = symbols.choose(index);
      let {name: sourceName, remap} = tableConf;
      remap = remap || sourceName;
      console.log(`\nBeginning restore of ${sourceName} to ${remap} with symbol ${symbol}`);

      let [accountId, tableName] = remap.split('/');

      let table = new azure.Table({
        accountId,
        sas: azureSAS.replace(/^\?/, ''),
      });

      await table.createTable(tableName).catch(async err => {
        if (err.code !== 'TableAlreadyExists') {
          throw err;
        }
        if ((await table.queryEntities(tableName, {top: 1})).entities.length > 0) {
          throw new Error(`Refusing to backup ${sourceName} to ${remap}. ${remap} not empty!`);
        }
      });

      let [sAccountId, sTableName] = sourceName.split('/');
      let fetch = s3.getObject({
        Bucket: bucket,
        Key: `${sAccountId}/table/${sTableName}`,
      }).createReadStream().pipe(zstd.decompressStream()).pipe(es.split()).pipe(es.parse());

      await new Promise((accept, reject) => {
        let rows = 0;
        let promises = [];
        fetch.on('data', async row => {
          promises.push(table.insertEntity(tableName, row));
          if (rows++ % 1000 === 0) {
            symbols.write(symbol);
          }
        });
        fetch.on('end', _ => Promise.all(promises).then(accept));
        fetch.on('error', reject);
      });

      console.log(`\nFinished restore of ${sourceName} to ${remap} with symbol ${symbol}`);
    }, {concurrency: concurrency});

    console.log('\nFinished restore.');
  },
};
