import { ApiPromise, WsProvider } from "@polkadot/api";
import { CalcPayout } from '@substrate/calc';
import { polkadotErasInfo } from './polkadotErasInfo.js';
import fs from 'fs';

async function fetchAccountStakingPayout(
    api,
    hash,
    address,
    era,
    currentEra,
    historicApi,
) {
    const { number } = await api.rpc.chain.getHeader(hash);

    const sanitizedEra = era < 0 ? 0 : era;

    const at = {
        height: number.unwrap().toString(10),
        hash,
    };

    // User friendly - we don't error if the user specified era & depth combo <= 0, instead just start at 0
    const startEra = era;
    const runtimeInfo = await api.rpc.state.getRuntimeVersion(at.hash);

    // Fetch general data about the era
    const allErasGeneral = await fetchAllErasGeneral(api, historicApi, startEra, sanitizedEra, at);

    // With the general data, we can now fetch the commission of each validator `address` nominates
    const allErasCommissions = await fetchAllErasCommissions(
        historicApi,
        address,
        startEra,
        // Create an array of `DeriveEraExposure`
        allErasGeneral.map((eraGeneral) => eraGeneral[0]),
    ).catch((err) => {
        throw err
    });

    // Group together data by Era so we can easily associate parts that are used congruently downstream
    const allEraData = allErasGeneral.map(
        ([deriveEraExposure, eraRewardPoints, erasValidatorRewardOption], idx) => {
            const eraCommissions = allErasCommissions[idx];

            const nominatedExposures = deriveNominatedExposures(address, deriveEraExposure);

            // Zip the `validatorId` with its associated `commission`, making the data easier to reason
            // about downstream
            const exposuresWithCommission = nominatedExposures?.map(({ validatorId }, idx) => {
                return {
                    validatorId,
                    ...eraCommissions[idx],
                };
            });

            return {
                deriveEraExposure,
                eraRewardPoints,
                erasValidatorRewardOption,
                exposuresWithCommission,
                eraIndex: historicApi.registry.createType('EraIndex', idx + startEra),
            };
        },
    );

    return {
        at,
        erasPayouts: allEraData.map((eraData) => deriveEraPayouts(api, address, eraData)),
    };
}

const fetchAllErasGeneral = async (
    api,
    historicApi,
    startEra,
    era,
    blockNumber,
) => {
    const allDeriveQuerys = [];
    let nextEraStartBlock = Number(blockNumber.height);
    let eraDurationInBlocks = 0;
    for (let e = startEra; e <= era; e += 1) {
        const eraIndex = historicApi.registry.createType('EraIndex', e);

        if (historicApi.query.staking.erasRewardPoints) {
            const eraGeneralTuple = Promise.all([
                deriveEraExposure(historicApi, eraIndex),
                historicApi.query.staking.erasRewardPoints(eraIndex),
                historicApi.query.staking.erasValidatorReward(eraIndex),
            ]);
            allDeriveQuerys.push(eraGeneralTuple);
        } else {
            const sessionDuration = (historicApi.consts.staking.sessionsPerEra).toNumber();
            const epochDuration = (historicApi.consts.babe.epochDuration).toNumber();
            eraDurationInBlocks = sessionDuration * epochDuration;
            const nextEraStartBlockHash = await api.rpc.chain.getBlockHash(nextEraStartBlock);
            const currentEraEndBlockHash =
                era === 0
                    ? await api.rpc.chain.getBlockHash(earlyErasBlockInfo[0].end)
                    : await api.rpc.chain.getBlockHash(earlyErasBlockInfo[era - 1].end);

            let reward = historicApi.registry.createType('Option<u128>');

            const blockInfo = await api.rpc.chain.getBlock(nextEraStartBlockHash);

            const allRecords = await historicApi.query.system.events();

            blockInfo.block.extrinsics.forEach((index) => {
                (allRecords)
                    .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
                    .forEach(({ event }) => {
                        if (event.method.toString() === 'Reward') {
                            const [dispatchInfo] = event.data;

                            reward = historicApi.registry.createType('Option<u128>', dispatchInfo.toString());
                        }
                    });
            });
            const points = fetchHistoricRewardPoints(api, currentEraEndBlockHash);
            const rewardPromise = new Promise<Option<u128>>((resolve) => {
                resolve(reward);
            });
            nextEraStartBlock = nextEraStartBlock - eraDurationInBlocks;

            const eraGeneralTuple = Promise.all([deriveEraExposure(historicApi, eraIndex), points, rewardPromise]);

            allDeriveQuerys.push(eraGeneralTuple);
        }
    }
    return Promise.all(allDeriveQuerys);
}

const fetchHistoricRewardPoints = async (api, hash) => {
    const historicApi = await api.at(hash);
    return historicApi.query.staking.currentEraPointsEarned();
}

const fetchAllErasCommissions = async (
    historicApi,
    address,
    startEra,
    deriveErasExposures,
) => {
    // Cache StakingLedger to reduce redundant queries to node
    const validatorLedgerCache = {};

    const allErasCommissions = deriveErasExposures.map((deriveEraExposure, idx) => {
        const currEra = idx + startEra;

        const nominatedExposures = deriveNominatedExposures(address, deriveEraExposure);

        if (!nominatedExposures) {
            return [];
        }

        const singleEraCommissions = nominatedExposures.map(({ validatorId }) =>
            fetchCommissionAndLedger(historicApi, validatorId, currEra, validatorLedgerCache),
        );

        return Promise.all(singleEraCommissions);
    });

    return Promise.all(allErasCommissions);
}

const deriveEraPayouts = (
    api,
    address,
    { deriveEraExposure, eraRewardPoints, erasValidatorRewardOption, exposuresWithCommission, eraIndex },
) => {
    if (!exposuresWithCommission) {
        return {
            message: `${address} has no nominations for the era ${eraIndex.toString()}`,
        };
    }
    if (erasValidatorRewardOption.isNone && eraIndex.toNumber() !== 0) {
        const event = eraIndex.toNumber() > 517 ? 'ErasValidatorReward' : 'Reward';
        return {
            message: `No ${event} for the era ${eraIndex.toString()}`,
        };
    }

    const totalEraRewardPoints = eraRewardPoints.total;
    const totalEraPayout =
        eraIndex.toNumber() !== 0 ? erasValidatorRewardOption.unwrap() : api.registry.createType('BalanceOf', 0);
    const calcPayout = CalcPayout.from_params(totalEraRewardPoints.toNumber(), totalEraPayout.toString(10));

    // Iterate through validators that this nominator backs and calculate payouts for the era
    const payouts = [];
    for (const { validatorId, commission: validatorCommission, validatorLedger } of exposuresWithCommission) {
        const totalValidatorRewardPoints = deriveEraExposure.validatorIndex
            ? extractTotalValidatorRewardPoints(eraRewardPoints, validatorId, deriveEraExposure.validatorIndex)
            : extractTotalValidatorRewardPoints(eraRewardPoints, validatorId);
        if (!totalValidatorRewardPoints || totalValidatorRewardPoints?.toNumber() === 0) {
            // Nothing to do if there are no reward points for the validator
            continue;
        }

        const { totalExposure, nominatorExposure } = extractExposure(address, validatorId, deriveEraExposure);

        if (nominatorExposure === undefined) {
            // This should not happen once at this point, but here for safety
            continue;
        }
        if (!validatorLedger) {
            continue;
        }

        /**
         * Check if the reward has already been claimed.
         *
         * It is important to note that the following examines types that are both current and historic.
         * When going back far enough in certain chains types such as `StakingLedgerTo240` are necessary for grabbing
         * any reward data.
         */
        let indexOfEra;
        if (validatorLedger.legacyClaimedRewards) {
            indexOfEra = validatorLedger.legacyClaimedRewards.indexOf(eraIndex);
        } else if ((validatorLedger).claimedRewards) {
            indexOfEra = (validatorLedger).claimedRewards.indexOf(eraIndex);
        } else if ((validatorLedger).lastReward) {
            const lastReward = (validatorLedger).lastReward;
            if (lastReward.isSome) {
                indexOfEra = lastReward.unwrap().toNumber();
            } else {
                indexOfEra = -1;
            }
        } else {
            continue;
        }
        const claimed = Number.isInteger(indexOfEra) && indexOfEra !== -1;

        const nominatorStakingPayout = calcPayout.calc_payout(
            totalValidatorRewardPoints.toNumber(),
            validatorCommission.toNumber(),
            nominatorExposure.unwrap().toString(10),
            totalExposure.unwrap().toString(10),
            address === validatorId,
        );

        payouts.push({
            validatorId,
            nominatorStakingPayout,
            claimed,
        });
    }

    let activeValidator = deriveEraExposure.validators[address] ? true : false;

    return {
        era: eraIndex,
        payouts,
        activeValidator,
    };
}

const fetchCommissionAndLedger = async (
    historicApi,
    validatorId,
    era,
    validatorLedgerCache,
) => {
    let commission;
    let validatorLedger;
    let commissionPromise;
    const ancient = era < 518;
    if (validatorId in validatorLedgerCache) {
        validatorLedger = validatorLedgerCache[validatorId];
        let prefs;
        if (!ancient) {
            prefs = await historicApi.query.staking.erasValidatorPrefs(era, validatorId);
            commission = prefs.commission.unwrap();
        } else {
            prefs = (await historicApi.query.staking.validators(validatorId));
            commission = (prefs[0]).commission.unwrap();
        }
    } else {
        commissionPromise = historicApi.query.staking.erasValidatorPrefs(era, validatorId);

        const [prefs, validatorControllerOption] = await Promise.all([
            commissionPromise,
            historicApi.query.staking.bonded(validatorId),
        ]);

        commission = prefs.commission.unwrap();

        if ((validatorControllerOption).isNone) {
            return {
                commission,
            };
        }

        const validatorLedgerOption = await historicApi.query.staking.ledger((validatorControllerOption).unwrap());
        if ((validatorLedgerOption).isNone) {
            return {
                commission,
            };
        }

        validatorLedger = (validatorLedgerOption).unwrap();
        validatorLedgerCache[validatorId] = validatorLedger;
    }

    return { commission, validatorLedger };
}

const deriveEraExposure = async (
    historicApi,
    eraIndex,
) => {
    function mapStakers(
        era,
        stakers,
        validatorIndex,
        validatorsOverviewEntries,
    ) {
        const nominators = {};
        const validators = {};
        const validatorsOverview = {};

        stakers.forEach(([key, exposure]) => {
            const validatorId = key.args[1].toString();

            if (validatorsOverviewEntries) {
                for (const validator of validatorsOverviewEntries) {
                    const validatorKey = validator[0];
                    const valKey = validatorKey.toHuman();
                    if (valKey) {
                        if (valKey[1].toString() === validatorId) {
                            validatorsOverview[validatorId] = validator[1];
                            break;
                        }
                    }
                }
            }

            validators[validatorId] = exposure;

            const individualExposure = exposure.others
                ? exposure.others
                : (exposure).isSome
                    ? (exposure).unwrap().others
                    : [];
            individualExposure.forEach(({ who }, validatorIndex) => {
                const nominatorId = who.toString();

                nominators[nominatorId] = nominators[nominatorId] || [];
                nominators[nominatorId].push({ validatorId, validatorIndex });
            });
        });
        if (Object.keys(validatorIndex).length > 0) {
            return { era, nominators, validators, validatorIndex, validatorsOverview };
        } else {
            return { era, nominators, validators, validatorsOverview };
        }
    }
    let storageKeys = [];
    let validatorsOverviewEntries = [];

    const validatorIndex = {};

    if (historicApi.query.staking.erasStakersClipped) {
        storageKeys = await historicApi.query.staking.erasStakersClipped.entries(eraIndex);
    } else {
        const validators = (await historicApi.query.staking.currentElected());

        const validatorId = [];

        validators.map((validator, index) => {
            validatorIndex[validator.toString()] = index;
            validatorId.push(validator);
        });

        let eraExposure = {};

        for (const validator of validatorId) {
            const storageKey = {
                args: [eraIndex, validator],
            };
            eraExposure = (await historicApi.query.staking.stakers(validator));
            storageKeys.push([storageKey, eraExposure]);
        }
    }

    if (storageKeys.length === 0 && historicApi.query.staking.erasStakersPaged) {
        storageKeys = await historicApi.query.staking.erasStakersPaged.entries(eraIndex);
        validatorsOverviewEntries = await historicApi.query.staking.erasStakersOverview.entries(eraIndex);
    }

    return mapStakers(eraIndex, storageKeys, validatorIndex, validatorsOverviewEntries);
}

const extractTotalValidatorRewardPoints = (
    eraRewardPoints,
    validatorId,
    validatorIndex,
) => {
    // Ideally we would just use the map's `get`, but that does not seem to be working here
    if (validatorIndex === undefined) {
        for (const [id, points] of eraRewardPoints.individual.entries()) {
            if (id.toString() === validatorId) {
                return points;
            }
        }
    } else {
        for (const [id, points] of eraRewardPoints.individual.entries()) {
            if (id.toString() === validatorIndex[validatorId.toString()].toString()) {
                return points;
            }
        }
    }

    return;
}

const extractExposure = (address, validatorId, deriveEraExposure) => {
    // Get total stake behind validator
    let totalExposure = {};
    if (deriveEraExposure.validators[validatorId].total) {
        totalExposure = deriveEraExposure.validators[validatorId].total;
    } else if (deriveEraExposure.validatorsOverview) {
        totalExposure = deriveEraExposure.validatorsOverview[validatorId].isSome
            ? deriveEraExposure.validatorsOverview[validatorId].unwrap().total
            : ({});
    }

    // Get nominators stake behind validator
    let exposureAllNominators = [];
    if (deriveEraExposure.validators[validatorId].others) {
        exposureAllNominators = deriveEraExposure.validators[validatorId].others;
    } else {
        const exposure = deriveEraExposure.validators[validatorId];

        exposureAllNominators = exposure.isSome
            ? ((exposure).unwrap()
                .others)
            : ([]);
    }
    let nominatorExposure;
    // check `address === validatorId` is when the validator is also the nominator we are getting payouts for
    if (address === validatorId && deriveEraExposure.validators[address].own) {
        nominatorExposure = deriveEraExposure.validators[address].own;
    } else if (address === validatorId && deriveEraExposure.validatorsOverview) {
        nominatorExposure = deriveEraExposure.validatorsOverview[address].isSome
            ? deriveEraExposure.validatorsOverview[address].unwrap().own
            : ({});
    } else {
        nominatorExposure = exposureAllNominators.find((exposure) => exposure.who.toString() === address)?.value;
    }
    return {
        totalExposure,
        nominatorExposure,
    };
}

const deriveNominatedExposures = (
    address,
    deriveEraExposure,
) => {
    let nominatedExposures = deriveEraExposure.nominators[address] ?? [];
    if (deriveEraExposure.validators[address]) {
        // We treat an `address` that is a validator as nominating itself
        nominatedExposures = nominatedExposures.concat({
            validatorId: address,
            // We put in an arbitrary number because we do not use the index
            validatorIndex: 9999,
        });
    }

    return nominatedExposures;
}

async function main () {
    // Retrieving user parameters/input from the command line
    const validatorId = process.argv[2];
    const eraStart = process.argv[3];
    const eraEnd = process.argv[4];
    const url = process.argv[5];

    // Checking if the user has provided the required parameters
    if (process.argv.length < 6) { 
        console.log("Usage: node index.js <validatorId> <eraStart> <eraEnd> <url>");
        return;
    }

    const range = eraEnd - eraStart;
    const validatorPayouts = [];

    const wsProvider = new WsProvider(url);
    const api = await ApiPromise.create({ provider: wsProvider });

    await api.isReady;

    for (let e = 0; e <= range; e++) {
        // Getting the era
        const era = parseInt(eraStart) + e;

        // Getting the last block of the queried era by fetching the starting block number of the era
        // that is 85 eras after the queried era and then subtracting 1 block from it.
        const blockNumber = polkadotErasInfo[era + 85].block_number - 1;
        const hash = await api.rpc.chain.getBlockHash(blockNumber);

        let historicApi = await api.at(hash);
        let currentEra = await historicApi.query.staking.currentEra();

        const payouts = await fetchAccountStakingPayout(api, hash, validatorId, era, currentEra.unwrap().toNumber(), historicApi);

        validatorPayouts.push(
            {
                validatorId, 
                era, 
                payout: payouts.erasPayouts[0].payouts[0]?.nominatorStakingPayout.toString(), 
                wasClaimed: payouts.erasPayouts[0].payouts[0]?.claimed.toString(),
                activeValidator: payouts.erasPayouts[0]?.activeValidator.toString(),
            }
        );
    }
    const jsonData = JSON.stringify({ validatorPayouts }, null, 2);
    fs.writeFileSync('validatorPayouts.json', jsonData, 'utf8');
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(-1);
  });
