import BPMEngine from 'bpm-engine';
import fs from 'fs';
import Promise from 'bluebird';

import mongoose from 'mongoose';

mongoose.Promise = Promise;

import PersistMongoose from 'bpm-engine-persist-mongoose';

import History from '../../bpm-engine/__tests__/Plugins/History';

describe('PersistMongoose', () => {
  let persistMongoose;

  beforeEach(async () => {
    persistMongoose = new PersistMongoose('mongodb://localhost:27017/bpm-engine-testing', {
      useMongoClient: true,
    });

    // clear process instances and token instances
    await persistMongoose.schemas.processInstance.remove({}).exec();
    await persistMongoose.schemas.tokenInstance.remove({}).exec();
  });

  afterEach(async () => {
    await persistMongoose.connection.close();
  });

  it('Work', async () => {
    const history = new History();

    const bpm = new BPMEngine({
      plugins: [history],
      persist: persistMongoose,
    });

    const processInstance = await bpm.createProcessInstance({
      workflowDefinition: fs.readFileSync(`${__dirname}/ParallelServices.bpmn`, 'utf-8'),
    });

    await processInstance.execute();

    expect((await persistMongoose.schemas.processInstance.find()).length).toMatchSnapshot();
    expect((await persistMongoose.schemas.tokenInstance.find()).length).toMatchSnapshot();
    expect(history.store).toMatchSnapshot();
  });
});
