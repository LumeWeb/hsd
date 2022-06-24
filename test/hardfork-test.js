'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const networks = require('../lib/protocol/networks');
const {isReserved, hashName} = require('../lib/covenants/rules');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const MTX = require('../lib/primitives/mtx');
const WorkerPool = require('../lib/workers/workerpool');
const consensus = require('../lib/protocol/consensus');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const {forValue} = require('./util/common');

describe('HARD FORK: Thumb Wrestle', function () {
  describe('Rules', function () {
    const main = Network.get('main');
    const {
      claimPeriod,
      extendedClaimPeriod
    } = main.names;

    it('should not extend claim period for alexa 100k', () => {
      assert(isReserved(hashName('bitcoin'), claimPeriod - 1, main));
      assert(!isReserved(hashName('bitcoin'), claimPeriod, main));
    });

    it('should extend claim period for alexa top 100', () => {
      assert(isReserved(hashName('twitter'), claimPeriod - 1, main));
      assert(isReserved(hashName('twitter'), claimPeriod, main));
      assert(isReserved(hashName('twitter'), claimPeriod + 1, main));
      assert(isReserved(hashName('twitter'), extendedClaimPeriod - 1, main));
      assert(!isReserved(hashName('twitter'), extendedClaimPeriod, main));
    });

    it('should extend claim period for custom reserved name', () => {
      assert(isReserved(hashName('icann'), claimPeriod - 1, main));
      assert(isReserved(hashName('icann'), claimPeriod, main));
      assert(isReserved(hashName('icann'), claimPeriod + 1, main));
      assert(isReserved(hashName('icann'), extendedClaimPeriod - 1, main));
      assert(!isReserved(hashName('icann'), extendedClaimPeriod, main));
    });
  });

  describe('Chain', function () {
    const network = Network.get('simnet');
    const activationHeight = network.thumbwrestleActivationHeight;

    for (const enabled of [true, false]) {
      describe(`Workers: ${enabled}`, function () {
        let packets;

        const workers = new WorkerPool({
          enabled,
          size: 2
        });

        workers.on('spawn', (child) => {
          child.on('packet', (packet) => {
            packets.push(packet);
          });
        });

        const blocks = new BlockStore({
          memory: true,
          network
        });

        const chain = new Chain({
          memory: true,
          blocks,
          network,
          workers
        });

        const miner = new Miner({
          chain,
          workers
        });

        const wallet = new MemWallet({
          network
        });

        chain.on('connect', async (entry, block) => {
          wallet.addBlock(entry, block.txs);
        });

        before(async () => {
          packets = [];
          await blocks.open();
          await chain.open();
          await miner.open();
        });

        after(async () => {
          await miner.close();
          await chain.close();
          await blocks.close();

          // Make sure we USED the workers in the "enabled" mode
          if (enabled)
            assert(packets.length);
          else
            assert(!packets.length);
        });

        it('should mine blocks towards activation height', async () => {
          miner.addresses.length = 0;
          miner.addAddress(wallet.getReceive());
          for (let i = 0; i < activationHeight - 2; i++) {
            const block = await miner.mineBlock();
            assert(await chain.add(block));
          }
        });

        it('should reject a TX before the fork with new forkid', async () => {
          assert(chain.height === activationHeight - 2);

          const mtx = new MTX();
          mtx.addOutput({
            address: wallet.getAddress(),
            value: 10 * 1e8
          });

          await wallet.fund(mtx);
          mtx.forkid = consensus.THUMBWRESTLE_FORK_ID;
          wallet.sign(mtx);

          const job = await miner.createJob();
          job.addTX(mtx.toTX(), mtx.view);
          job.refresh();
          const block = await job.mineAsync();

          await assert.rejects(
            chain.add(block),
            {
              message: 'Verification failure: ' +
                       'mandatory-script-verify-flag-failed ' +
                       '(code=invalid score=100 '+
                       `hash=${block.hash().toString('hex')})`
            }
          );
        });

        it('should confirm a TX before the fork with null forkid', async () => {
          assert(chain.height === activationHeight - 2);

          const mtx = new MTX();
          mtx.addOutput({
            address: wallet.getAddress(),
            value: 10 * 1e8
          });

          await wallet.fund(mtx);
          assert(mtx.forkid === null);
          wallet.sign(mtx);

          const job = await miner.createJob();
          job.addTX(mtx.toTX(), mtx.view);
          job.refresh();
          const block = await job.mineAsync();

          assert(await chain.add(block));
        });

        it('should reject a TX at the fork with null forkid', async () => {
          assert(chain.height === activationHeight - 1);

          const mtx = new MTX();
          mtx.addOutput({
            address: wallet.getAddress(),
            value: 10 * 1e8
          });

          await wallet.fund(mtx);
          assert(mtx.forkid === null);
          wallet.sign(mtx);

          const job = await miner.createJob();
          job.addTX(mtx.toTX(), mtx.view);
          job.refresh();
          const block = await job.mineAsync();

          await assert.rejects(
            chain.add(block),
            {
              message: 'Verification failure: ' +
                       'mandatory-script-verify-flag-failed ' +
                       '(code=invalid score=100 '+
                       `hash=${block.hash().toString('hex')})`
            }
          );
        });

        it('should confirm a TX at the fork with new forkid', async () => {
          assert(chain.height === activationHeight - 1);

          const mtx = new MTX();
          mtx.addOutput({
            address: wallet.getAddress(),
            value: 10 * 1e8
          });

          await wallet.fund(mtx);
          mtx.forkid = consensus.THUMBWRESTLE_FORK_ID;
          wallet.sign(mtx);

          const job = await miner.createJob();
          job.addTX(mtx.toTX(), mtx.view);
          job.refresh();
          const block = await job.mineAsync();

          assert(await chain.add(block));

          assert(chain.height === activationHeight); // forked!
        });
      });
    }
  });

  describe('P2P Integration', function () {
    this.timeout(10000);
    // Clone simnet that never forks
    networks.simnetClassic = Object.assign({}, networks.simnet);
    networks.simnetClassic.thumbwrestleActivationHeight = Infinity;
    networks.simnetClassic.type = 'simnetClassic';
    networks.types.push('simnetClassic');

    const activationHeight = networks.simnet.thumbwrestleActivationHeight;

    const ports = {
      fullNew: 10001,
      fullOld: 10002,
      spvNew: 10003,
      spvOld: 10004
    };

    const fullNew = new FullNode({
      network: 'simnet',
      memory: true,
      listen: true,
      bip37: true,
      port: ports.fullNew,
      brontidePort: ports.fullNew + 1000,
      httpPort: ports.fullNew + 2000,
      noDns: true,
      only: [
        `127.0.0.1:${ports.fullOld}`
      ]
    });

    const fullOld = new FullNode({
      network: 'simnetClassic',
      memory: true,
      listen: true,
      bip37: true,
      port: ports.fullOld,
      brontidePort: ports.fullOld + 1000,
      httpPort: ports.fullOld + 2000,
      noDns: true,
      only: [
        `127.0.0.1:${ports.fullNew}`
      ]
    });

    const spvNew = new SPVNode({
      network: 'simnet',
      memory: true,
      port: ports.spvNew,
      brontidePort: ports.spvNew + 1000,
      httpPort: ports.spvNew + 2000,
      noDns: true,
      only: [
        `127.0.0.1:${ports.fullOld}`,
        `127.0.0.1:${ports.fullNew}`
      ]
    });

    const spvOld = new SPVNode({
      network: 'simnetClassic',
      memory: true,
      port: ports.spvOld,
      brontidePort: ports.spvOld + 1000,
      httpPort: ports.spvOld + 2000,
      noDns: true,
      only: [
        `127.0.0.1:${ports.fullOld}`,
        `127.0.0.1:${ports.fullNew}`
      ]
    });

    const fullNewBanned = [];
    const fullOldBanned = [];
    const spvNewBanned = [];
    const spvOldBanned = [];
    fullNew.pool.on('ban', peer => fullNewBanned.push(peer));
    fullOld.pool.on('ban', peer => fullOldBanned.push(peer));
    spvNew.pool.on('ban', peer => spvNewBanned.push(peer));
    spvOld.pool.on('ban', peer => spvOldBanned.push(peer));

    before(async () => {
      await fullNew.open();
      await fullOld.open();
      await spvNew.open();
      await spvOld.open();

      await fullNew.connect();
      await fullOld.connect();
      await spvNew.connect();
      await spvOld.connect();

      await fullNew.startSync();
      await fullOld.startSync();
      await spvNew.startSync();
      await spvOld.startSync();
    });

    after(async () => {
      await fullNew.close();
      await fullOld.close();
      await spvNew.close();
      await spvOld.close();
    });

    it('should have connected all four nodes', async () => {
      // Full nodes connect to each other,
      // each SPV node connects to each full node
      await forValue(fullNew.pool.peers, 'inbound', 3);
      await forValue(fullOld.pool.peers, 'inbound', 3);
      await forValue(spvNew.pool.peers, 'inbound', 0);
      await forValue(spvOld.pool.peers, 'inbound', 0);
      await forValue(fullNew.pool.peers, 'outbound', 1);
      await forValue(fullOld.pool.peers, 'outbound', 1);
      await forValue(spvNew.pool.peers, 'outbound', 2);
      await forValue(spvOld.pool.peers, 'outbound', 2);
    });

    it('should generate common blocks', async () => {
      for (let i = 0; i < activationHeight - 1; i++)
        await fullNew.chain.add(await fullNew.miner.mineBlock());

      assert.strictEqual(fullNew.chain.height, activationHeight - 1);
      await forValue(fullOld.chain, 'height', fullNew.chain.height);
      await forValue(spvNew.chain, 'height', fullNew.chain.height);
      await forValue(spvOld.chain, 'height', fullNew.chain.height);
    });

    it('should begin splitting the network', async () => {
      await fullNew.chain.add(await fullNew.miner.mineBlock());

      // SPV nodes follow most-work chain
      assert.strictEqual(fullNew.chain.height, activationHeight);
      await forValue(spvNew.chain, 'height', fullNew.chain.height);
      await forValue(spvOld.chain, 'height', fullNew.chain.height);

      // Old full node is still on previous block
      assert.strictEqual(fullOld.chain.height, activationHeight - 1);

      // Some nodes disconnected, explanation in ban checks below
      await forValue(fullNew.pool.peers, 'inbound', 2);
      await forValue(fullOld.pool.peers, 'inbound', 3);
      await forValue(spvNew.pool.peers, 'inbound', 0);
      await forValue(spvOld.pool.peers, 'inbound', 0);
      await forValue(fullNew.pool.peers, 'outbound', 1);
      await forValue(fullOld.pool.peers, 'outbound', 0);
      await forValue(spvNew.pool.peers, 'outbound', 2);
      await forValue(spvOld.pool.peers, 'outbound', 2);

      // fullOld banned fullNew for sending invalid block
      assert.strictEqual(fullOldBanned.length, 1);
      assert.strictEqual(
        fullOldBanned[0].address.hostname,
        `127.0.0.1:${ports.fullNew}`
      );

      // fullNew hasn't banned fullOld yet, they haven't misbehaved
      assert.strictEqual(fullNewBanned.length, 0);

      // SPV nodes are still pretty dumb
      assert.strictEqual(spvNewBanned.length, 0);
      assert.strictEqual(spvOldBanned.length, 0);
    });

    it('should completely split the network', async () => {
      let spvOldReorged = false;
      spvOld.on('reorganize', () => spvOldReorged = true);

      // Simulates "classic" network with higher hashrate, more-work chain
      for (let i = 0; i < 4; i++)
        await fullOld.chain.add(await fullOld.miner.mineBlock());

      // spvOld node reorged to fullOld's most-work chain
      assert.strictEqual(fullOld.chain.height, activationHeight + 3);
      await forValue(spvOld.chain, 'height', fullOld.chain.height);
      assert(spvOldReorged);

      // Remainder of incompatible nodes disconnected
      await forValue(fullNew.pool.peers, 'inbound', 2);
      await forValue(fullOld.pool.peers, 'inbound', 1);
      await forValue(spvNew.pool.peers, 'inbound', 0);
      await forValue(spvOld.pool.peers, 'inbound', 0);
      await forValue(fullNew.pool.peers, 'outbound', 0);
      await forValue(fullOld.pool.peers, 'outbound', 0);
      await forValue(spvNew.pool.peers, 'outbound', 1);
      await forValue(spvOld.pool.peers, 'outbound', 2);

      // fullNew banned fullOld for sending invalid block
      assert.strictEqual(fullNewBanned.length, 1);
      assert.strictEqual(
        fullNewBanned[0].address.hostname,
        `127.0.0.1:${ports.fullOld}`
      );

      // spvNew banned fullOld for sending invalid block (header!)
      assert.strictEqual(spvNewBanned.length, 1);
      assert.strictEqual(
        spvNewBanned[0].address.hostname,
        `127.0.0.1:${ports.fullOld}`
      );

      // Old SPV node is still pretty dumb
      assert.strictEqual(spvOldBanned.length, 0);
    });
  });
});
