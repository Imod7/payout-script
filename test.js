const { ApiPromise, WsProvider } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const fs = require('fs');
const Papa = require('papaparse');
require('dotenv').config();
const earlyErasBlockInfo = require('./kusamaEarlyErasBlockInfo.json');

async function getCommissions(api, validatorAddr, era, isKusama) {
    let commission;
    let commissionPromise;
    const ancient = era < 518;
    commissionPromise =
        ancient && isKusama
            ? api.query.staking.validators(validatorAddr)
            : api.query.staking.erasValidatorPrefs(era, validatorAddr);

    const prefs = await commissionPromise;

    commission =
        ancient && isKusama
            ? (prefs[0]).commission.unwrap()
            : prefs.commission.unwrap();

    
    return { commission };

}

async function getPoints(api, validatorAddr, era) {
    const eraIndex = api.registry.createType('EraIndex', era);

    let eraPoints;
    let validatorPoints;

    if (api.query.staking.erasRewardPoints) {
        eraPoints = await api.query.staking.erasRewardPoints(eraIndex);
        validatorPoints = await api.query.staking.erasValidatorReward(eraIndex);
    } else {
        // We check if we are in the Kusama chain since currently we have
        // the block info for the early eras only for Kusama.
        if (isKusama) {
            // Retrieve the first block of the era following the given era in order
            // to fetch the `Rewards` event at that block.
            nextEraStartBlock = era === 0 ? earlyErasBlockInfo[era + 1].start : earlyErasBlockInfo[era].start;
        } else {
            const sessionDuration = api.consts.staking.sessionsPerEra.toNumber();
            const epochDuration = api.consts.babe.epochDuration.toNumber();
            eraDurationInBlocks = sessionDuration * epochDuration;
        }
        const nextEraStartBlockHash = await this.api.rpc.chain.getBlockHash(nextEraStartBlock);
        const currentEraEndBlockHash =
            era === 0
                ? await api.rpc.chain.getBlockHash(earlyErasBlockInfo[0].end)
                : await api.rpc.chain.getBlockHash(earlyErasBlockInfo[era - 1].end);

        let reward = api.registry.createType('Option<u128>');

        const blockInfo = await api.rpc.chain.getBlock(nextEraStartBlockHash);

        const allRecords = await api.query.system.events();

        blockInfo.block.extrinsics.forEach((index) => {
            allRecords
                .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
                .forEach(({ event }) => {
                    if (event.method.toString() === 'Reward') {
                        const [dispatchInfo] = event.data;

                        reward = api.registry.createType('Option<u128>', dispatchInfo.toString());
                    }
                });
        });
        const points = await api.at(currentEraEndBlockHash).query.staking.currentEraPointsEarned();

        if (!isKusama) {
            nextEraStartBlock = nextEraStartBlock - eraDurationInBlocks;
        }
        let exposure;
        if (api.query.staking.erasStakersClipped) {
			exposure = await api.query.staking.erasStakersClipped(eraIndex, validatorAddr);
		} else {
            exposure = await api.query.staking.stakers(validatorAddr);
        }

        return { points, reward, exposure}
    }



}
async function main() {
    const provider = new WsProvider("wss://dot-rpc.stakeworld.io");
    //Accounts we want to query
    const accounts = process.env.ADDR.split(",");
    const chain = process.env.CHAIN;
    const values = `./${chain}_era_block_numbers.csv`

    const csvData = fs.readFileSync(values, 'utf8');

    const parsed = Papa.parse(csvData, {
        header: true
    });

    const eras = [];
    const blocks = [];
    const retrievedData = [];

    parsed.data.map((info) => {
        eras.push(info.current_era_index);
        blocks.push(info.block_number);
    })

    for (let account of accounts) {
        for (let era of eras) {
            let ancient = false;
            let isValidator = true;
            const queriedEra = era;
            const block = blocks[era - 1];
            await cryptoWaitReady();

            const api = await ApiPromise.create({
                provider: provider,
            });
            await api.isReady;

            const runtimeInfo = await api.rpc.state.getRuntimeVersion(at.hash);

            const isKusama = runtimeInfo.specName.toString().toLowerCase() === 'kusama';

            // Block number when we know the rewards weren't claimable anymore 
            // Source: https://wiki.polkadot.network/docs/maintain-polkadot-parameters#periods-of-common-actions-and-attributes for Polkadot
            // and https://guide.kusama.network/docs/kusama-parameters/#periods-of-common-actions-and-attributes for Kusama
            // Also see https://github.com/paritytech/polkadot-sdk/blob/0bb6249268c0b77d2834640b84cb52fdd3d7e860/substrate/frame/staking/src/lib.rs#L114C1-L122C1 for the payout discard
            const discardedBlockAt = era + 84 > currentEra ? currentEra : blocks[era + 84];

            const hash = await api.rpc.chain.getBlockHash(block);
            const historicApi = await api.at(hash);
            const stakingVersion = await historicApi.query.staking.palletVersion();

            const { commission } = getCommissions(historicApi, account, era, isKusama, Number(stakingVersion));

            const { points, reward , exposure } = await getPoints(historicApi, account, era);

            const calcPayout = CalcPayout.from_params(Number(points.total), reward.toString(10));


            const payout = calcPayout.calc_payout(
                Number(points.individual.toJSON(validatorAddr)),
                Number(commission),
                exposure.unwrap().own.toString(10),
                exposure.unwrap().total.toString(10),
                true,
            );


            const newValidatorInfo = apiAt.query.staking.erasStakersPaged ? await apiAt.query.staking.erasStakersPaged(queriedEra, account, 0) : await apiAt.query.staking.erasStakers(queriedEra, account);

            const dropped = Number(newValidatorInfo.toJSON().total) == 0 ? true : false;

            // If the account hasn't claimed anything for a while, it's state is dropped
            if (dropped) {
                console.log('The Account hasn\'t claimed the rewards for this era')
                retrievedData.push({ account: account, era: era, isValidator: isValidator, rewards: reward, claimed: false })
                // We check if we are in a transition period
            } else if (newApiAt.query.staking.claimedRewards && newApiAt.query.staking.ledger) {
                console.log("transition")
                const legacy = await newApiAt.query.staking.ledger(account);
                const legacyClaimed = legacy.toJSON().claimedRewards ? legacy.toJSON().claimedRewards : legacy.toJSON().legacyClaimedRewards;
                const hasLegacyClaimedForEra = legacyClaimed.includes(queriedEra);
                const current = await newApiAt.query.staking.claimedRewards(account);
                const hasCurrentClaimedForEra = current.toJSON().includes(queriedEra);
                const hasUnclaimed = hasLegacyClaimedForEra || hasCurrentClaimedForEra;
                console.log('The Account hasn\'t claimed the rewards for this era? ' + hasUnclaimed)
                retrievedData.push({ account: account, era: era, isValidator: isValidator, rewards: reward, claimed: hasUnclaimed })
                // We check if we are using the legacy rewards or the new rewards call
            } else if (newApiAt.query.staking.claimedRewards) {
                console.log("new")
                const claimed = await newApiAt.staking.claimedRewards(account);
                const hasClaimedForEra = claimed.toJSON().includes(queriedEra);
                console.log('The Account hasn\'t claimed the rewards for this era? ' + !hasClaimedForEra)
                retrievedData.push({ account: account, era: era, isValidator: isValidator, rewards: reward, claimed: hasClaimedForEra })

            } else if (newApiAt.query.staking.ledger) {
                console.log("legacy")
                const ledger = await newApiAt.query.staking.ledger(account);
                const claimed = ledger.toJSON().claimedRewards ? ledger.toJSON().claimedRewards : ledger.toJSON().legacyClaimedRewards;
                const hasClaimedForEra = claimed.includes(queriedEra);
                console.log('The Account hasn\'t claimed the rewards for this era? ' + !hasClaimedForEra)
                retrievedData.push({ account: account, era: era, isValidator: isValidator, rewards: reward, claimed: hasClaimedForEra })

            }
        }
    }
}

main()
    .catch(console.error)
    .finally(() => process.exit());