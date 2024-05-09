import '@polkadot/api-augment';
import type { ApiDecoration } from '@polkadot/api/types';
import type {
    DeriveEraExposure,
    DeriveEraExposureNominating,
    DeriveEraNominatorExposure,
    DeriveEraValidatorExposure,
} from '@polkadot/api-derive/staking/types';
import { Compact, Option, StorageKey, u16, u32, u64, u128 } from '@polkadot/types';
import { Vec } from '@polkadot/types';
import type {
    AccountId,
    AccountId32,
    BalanceOf,
    BlockHash,
    EraIndex,
    EraPoints,
    Perbill,
    StakingLedger,
    StakingLedgerTo240,
    ValidatorPrefsWithCommission,
    RewardPoint,
    Balance
} from '@polkadot/types/interfaces';
import {
    PalletStakingEraRewardPoints,
    PalletStakingStakingLedger,
    PalletStakingUnlockChunk,
    PalletStakingValidatorPrefs,
    SpStakingExposure,
    SpStakingExposurePage,
    SpStakingIndividualExposure,
    SpStakingPagedExposureMetadata,
    FrameSystemEventRecord
} from '@polkadot/types/lookup';
import { CalcPayout } from '@substrate/calc';
import { ApiPromise, WsProvider } from '@polkadot/api';
import kusamaEarlyErasBlockInfo from './kusamaEarlyErasBlockInfo.json';
import polkadotErasInfo from './polkadotErasInfo.json';

interface LegacyPalletStakingStakingLedger {
    stash: AccountId32;
    total: Compact<u128>;
    active: Compact<u128>;
    unlocking: Vec<PalletStakingUnlockChunk>;
    claimedRewards: Vec<u32>;
}

interface IAt {
    hash: string | BlockHash;
    height: string;
}

interface IPayout {
    validatorId: string;
    nominatorStakingPayout: string;
    claimed: boolean;
    validatorCommission: Perbill;
    totalValidatorRewardPoints: RewardPoint;
    totalValidatorExposure: Balance;
    nominatorExposure: Balance;
}

interface IEraPayouts {
    era: EraIndex;
    totalEraRewardPoints: RewardPoint;
    totalEraPayout: BalanceOf;
    payouts: IPayout[];
}

interface IAccountStakingPayouts {
    at: IAt;
    erasPayouts: (IEraPayouts | { message: string })[];
}

/**
 * Copyright 2024 via polkadot-js/api
 * The following code was adopted by https://github.com/polkadot-js/api/blob/3bdf49b0428a62f16b3222b9a31bfefa43c1ca55/packages/api-derive/src/staking/erasExposure.ts.
 */
type KeysAndExposures = [StorageKey<[EraIndex, AccountId]>, SpStakingExposure][];

type IPoints = PalletStakingEraRewardPoints | EraPoints;

/**
 * General information about an era, in tuple form because we initially get it
 * by destructuring a Promise.all(...)
 */
type IErasGeneral = [IAdjustedDeriveEraExposure, IPoints, Option<BalanceOf>];

/**
 * Index of the validator for eras previous to 518 in Kusama chain.
 */
interface ValidatorIndex {
    [x: string]: number;
}
/**
 * Adapted AdjustedDeriveEraExposure interface for compatibility:
 * - with eras previous to 518 in Kusama chain (via `validatorIndex` property) and
 * - with Staking changes (3 new calls including `ErasStakersOverview`) in
 *   Polkadot v1.2.0 runtime (via `validatorOverview` property). Relevant PR:
 *   https://github.com/paritytech/polkadot-sdk/pull/1189
 */
interface IAdjustedDeriveEraExposure extends DeriveEraExposure {
    validatorIndex?: ValidatorIndex;
    validatorsOverview?: Record<string, Option<SpStakingPagedExposureMetadata>>;
}

/**
 * Commission and staking ledger of a validator
 */
interface ICommissionAndLedger {
    commission: Perbill;
    validatorLedger?: PalletStakingStakingLedger;
}

/**
 * All the data we need to calculate payouts for an address at a given era.
 */
interface IEraData {
    deriveEraExposure: IAdjustedDeriveEraExposure;
    eraRewardPoints: PalletStakingEraRewardPoints | EraPoints;
    erasValidatorRewardOption: Option<BalanceOf>;
    exposuresWithCommission?: (ICommissionAndLedger & {
        validatorId: string;
    })[];
    eraIndex: EraIndex;
}

/**
 * Block information relevant for compatibility with eras previous
 * to 518 in Kusama chain.
 */
interface IBlockInfo {
    height: string;
    hash: BlockHash;
}

interface IEarlyErasBlockInfo {
    [era: string]: {
        start: number;
        end: number;
    };
}

interface IValidatorsPayoutInfo {
    validatorId: string,
    era: number,
    payout: string,
    wasClaimed: boolean,
}

const fetchAccountStakingPayout = async (
    api: ApiPromise,
    hash: BlockHash,
    address: string,
    depth: number,
    era: number,
    unclaimedOnly: boolean,
    currentEra: number,
    historicApi: ApiDecoration<'promise'>,
): Promise<IAccountStakingPayouts> => {
    const { number } = await api.rpc.chain.getHeader(hash);

    const sanitizedEra = era < 0 ? 0 : era;

    const at: IBlockInfo = {
        height: number.unwrap().toString(10),
        hash,
    };

    // User friendly - we don't error if the user specified era & depth combo <= 0, instead just start at 0
    const startEra = Math.max(0, sanitizedEra - (depth - 1));
    const runtimeInfo = await api.rpc.state.getRuntimeVersion(at.hash);
    const isKusama = runtimeInfo.specName.toString().toLowerCase() === 'kusama';

    /**
     * Given https://github.com/polkadot-js/api/issues/5232,
     * polkadot-js, and substrate treats historyDepth as a consts. In order
     * to maintain historical integrity we need to make a check to cover both the
     * storage query and the consts.
     */
    let historyDepth: u32 = api.registry.createType('u32', 84);
    if (historicApi.consts.staking.historyDepth) {
        historyDepth = (historicApi.consts.staking.historyDepth as u32);
    } else if (historicApi.query.staking.historyDepth) {
        historyDepth = await historicApi.query.staking.historyDepth<u32>();
    } else if (currentEra < 518 && isKusama) {
        historyDepth = api.registry.createType('u32', 0);
    }

    // Fetch general data about the era
    const allErasGeneral = await fetchAllErasGeneral(api, historicApi, startEra, sanitizedEra, at, isKusama);

    // With the general data, we can now fetch the commission of each validator `address` nominates
    const allErasCommissions = await fetchAllErasCommissions(
        historicApi,
        address,
        startEra,
        // Create an array of `DeriveEraExposure`
        allErasGeneral.map((eraGeneral) => eraGeneral[0]),
        isKusama,
    ).catch((err: Error) => {
        throw err
    });

    // Group together data by Era so we can easily associate parts that are used congruently downstream
    const allEraData = allErasGeneral.map(
        ([deriveEraExposure, eraRewardPoints, erasValidatorRewardOption]: IErasGeneral, idx: number): IEraData => {
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
        erasPayouts: allEraData.map((eraData) => deriveEraPayouts(api, address, unclaimedOnly, eraData, isKusama)),
    };
}

const fetchAllErasGeneral = async (
    api: ApiPromise,
    historicApi: ApiDecoration<'promise'>,
    startEra: number,
    era: number,
    blockNumber: IBlockInfo,
    isKusama: boolean,
): Promise<IErasGeneral[]> => {
    const allDeriveQuerys: Promise<IErasGeneral>[] = [];
    let nextEraStartBlock: number = Number(blockNumber.height);
    let eraDurationInBlocks: number = 0;
    const earlyErasBlockInfo: IEarlyErasBlockInfo = kusamaEarlyErasBlockInfo;
    for (let e = startEra; e <= era; e += 1) {
        const eraIndex: EraIndex = historicApi.registry.createType('EraIndex', e);

        if (historicApi.query.staking.erasRewardPoints) {
            const eraGeneralTuple = Promise.all([
                deriveEraExposure(historicApi, eraIndex),
                historicApi.query.staking.erasRewardPoints(eraIndex) as unknown as Promise<IPoints>,
                historicApi.query.staking.erasValidatorReward(eraIndex) as unknown as Promise<Option<BalanceOf>>,
            ]);
            allDeriveQuerys.push(eraGeneralTuple);
        } else {
            // We check if we are in the Kusama chain since currently we have
            // the block info for the early eras only for Kusama.
            if (isKusama) {
                // Retrieve the first block of the era following the given era in order
                // to fetch the `Rewards` event at that block.
                nextEraStartBlock = era === 0 ? earlyErasBlockInfo[era + 1].start : earlyErasBlockInfo[era].start;
            } else {
                const sessionDuration = (historicApi.consts.staking.sessionsPerEra as unknown as u32).toNumber();
                const epochDuration = (historicApi.consts.babe.epochDuration as unknown as u64).toNumber();
                eraDurationInBlocks = sessionDuration * epochDuration;
            }
            const nextEraStartBlockHash: BlockHash = await api.rpc.chain.getBlockHash(nextEraStartBlock);
            const currentEraEndBlockHash: BlockHash =
                era === 0
                    ? await api.rpc.chain.getBlockHash(earlyErasBlockInfo[0].end)
                    : await api.rpc.chain.getBlockHash(earlyErasBlockInfo[era - 1].end);

            let reward: Option<u128> = historicApi.registry.createType('Option<u128>');

            const blockInfo = await api.rpc.chain.getBlock(nextEraStartBlockHash);

            const allRecords = await historicApi.query.system.events();

            blockInfo.block.extrinsics.forEach((index) => {
                (allRecords as Vec<FrameSystemEventRecord>)
                    .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
                    .forEach(({ event }) => {
                        if (event.method.toString() === 'Reward') {
                            const [dispatchInfo] = event.data;

                            reward = historicApi.registry.createType('Option<u128>', dispatchInfo.toString());
                        }
                    });
            });
            const points = fetchHistoricRewardPoints(api, currentEraEndBlockHash);
            const rewardPromise: Promise<Option<u128>> = new Promise<Option<u128>>((resolve) => {
                resolve(reward);
            });
            if (!isKusama) {
                nextEraStartBlock = nextEraStartBlock - eraDurationInBlocks;
            }

            const eraGeneralTuple = Promise.all([deriveEraExposure(historicApi, eraIndex), points, rewardPromise]);

            allDeriveQuerys.push(eraGeneralTuple);
        }
    }
    return Promise.all(allDeriveQuerys);
}

const fetchHistoricRewardPoints = async (api: ApiPromise, hash: BlockHash): Promise<EraPoints> => {
    const historicApi = await api.at(hash);
    return historicApi.query.staking.currentEraPointsEarned() as unknown as EraPoints;
}

const fetchAllErasCommissions = async (
    historicApi: ApiDecoration<'promise'>,
    address: string,
    startEra: number,
    deriveErasExposures: IAdjustedDeriveEraExposure[],
    isKusama: boolean,
): Promise<ICommissionAndLedger[][]> => {
    // Cache StakingLedger to reduce redundant queries to node
    const validatorLedgerCache: { [id: string]: PalletStakingStakingLedger } = {};

    const allErasCommissions = deriveErasExposures.map((deriveEraExposure, idx) => {
        const currEra = idx + startEra;

        const nominatedExposures = deriveNominatedExposures(address, deriveEraExposure);

        if (!nominatedExposures) {
            return [];
        }

        const singleEraCommissions = nominatedExposures.map(({ validatorId }) =>
            fetchCommissionAndLedger(historicApi, validatorId, currEra, validatorLedgerCache, isKusama),
        );

        return Promise.all(singleEraCommissions);
    });

    return Promise.all(allErasCommissions);
}

const deriveEraPayouts = (
    api: ApiPromise,
    address: string,
    unclaimedOnly: boolean,
    { deriveEraExposure, eraRewardPoints, erasValidatorRewardOption, exposuresWithCommission, eraIndex }: IEraData,
    isKusama: boolean,
): IEraPayouts | { message: string } => {
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
    const totalEraPayout: BalanceOf =
        eraIndex.toNumber() !== 0 ? erasValidatorRewardOption.unwrap() : api.registry.createType('BalanceOf', 0);
    const calcPayout = CalcPayout.from_params(totalEraRewardPoints.toNumber(), totalEraPayout.toString(10));

    // Iterate through validators that this nominator backs and calculate payouts for the era
    const payouts: IPayout[] = [];
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
        let indexOfEra: number;
        if (validatorLedger.legacyClaimedRewards) {
            indexOfEra = validatorLedger.legacyClaimedRewards.indexOf(eraIndex);
        } else if ((validatorLedger as unknown as StakingLedger).claimedRewards) {
            indexOfEra = (validatorLedger as unknown as StakingLedger).claimedRewards.indexOf(eraIndex);
        } else if ((validatorLedger as unknown as StakingLedgerTo240).lastReward) {
            const lastReward = (validatorLedger as unknown as StakingLedgerTo240).lastReward;
            if (lastReward.isSome) {
                indexOfEra = lastReward.unwrap().toNumber();
            } else {
                indexOfEra = -1;
            }
        } else if (eraIndex.toNumber() < 518 && isKusama) {
            indexOfEra = eraIndex.toNumber();
        } else {
            continue;
        }
        const claimed: boolean = Number.isInteger(indexOfEra) && indexOfEra !== -1;
        if (unclaimedOnly && claimed) {
            continue;
        }

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
            totalValidatorRewardPoints,
            validatorCommission,
            totalValidatorExposure: totalExposure.unwrap(),
            nominatorExposure: nominatorExposure.unwrap(),
        });
    }

    return {
        era: eraIndex,
        totalEraRewardPoints,
        totalEraPayout,
        payouts,
    };
}

const fetchCommissionAndLedger = async (
    historicApi: ApiDecoration<'promise'>,
    validatorId: string,
    era: number,
    validatorLedgerCache: { [id: string]: PalletStakingStakingLedger },
    isKusama: boolean,
): Promise<ICommissionAndLedger> => {
    let commission: Perbill;
    let validatorLedger;
    let commissionPromise;
    const ancient: boolean = era < 518;
    if (validatorId in validatorLedgerCache) {
        validatorLedger = validatorLedgerCache[validatorId];
        let prefs: PalletStakingValidatorPrefs | ValidatorPrefsWithCommission;
        if (!ancient) {
            prefs = await historicApi.query.staking.erasValidatorPrefs(era, validatorId) as PalletStakingValidatorPrefs;
            commission = prefs.commission.unwrap();
        } else {
            prefs = (await historicApi.query.staking.validators(validatorId)) as ValidatorPrefsWithCommission;
            commission = (prefs[0] as PalletStakingValidatorPrefs | ValidatorPrefsWithCommission).commission.unwrap();
        }
    } else {
        commissionPromise =
            ancient && isKusama
                ? historicApi.query.staking.validators(validatorId)
                : historicApi.query.staking.erasValidatorPrefs(era, validatorId);

        const [prefs, validatorControllerOption] = await Promise.all([
            commissionPromise,
            historicApi.query.staking.bonded(validatorId),
        ]);

        commission =
            ancient && isKusama
                ? (prefs[0] as PalletStakingValidatorPrefs | ValidatorPrefsWithCommission).commission.unwrap()
                : prefs.commission.unwrap();

        if ((validatorControllerOption as Option<AccountId32>).isNone) {
            return {
                commission,
            };
        }

        const validatorLedgerOption = await historicApi.query.staking.ledger((validatorControllerOption as Option<AccountId32>).unwrap());
        if ((validatorLedgerOption as Option<PalletStakingStakingLedger>).isNone) {
            return {
                commission,
            };
        }

        validatorLedger = (validatorLedgerOption as Option<PalletStakingStakingLedger>).unwrap();
        validatorLedgerCache[validatorId] = validatorLedger;
    }

    return { commission, validatorLedger };
}

const deriveEraExposure = async (
    historicApi: ApiDecoration<'promise'>,
    eraIndex: EraIndex,
): Promise<IAdjustedDeriveEraExposure> => {
    function mapStakers(
        era: EraIndex,
        stakers: KeysAndExposures,
        validatorIndex: ValidatorIndex,
        validatorsOverviewEntries?: [StorageKey, Option<SpStakingPagedExposureMetadata>][],
    ): IAdjustedDeriveEraExposure {
        const nominators: DeriveEraNominatorExposure = {};
        const validators: DeriveEraValidatorExposure = {};
        const validatorsOverview: Record<string, Option<SpStakingPagedExposureMetadata>> = {};

        stakers.forEach(([key, exposure]): void => {
            const validatorId = key.args[1].toString();

            if (validatorsOverviewEntries) {
                for (const validator of validatorsOverviewEntries) {
                    const validatorKey: StorageKey = validator[0];
                    const valKey: [string, string] = validatorKey.toHuman() as unknown as [string, string];
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
                : (exposure as unknown as Option<SpStakingExposurePage>).isSome
                    ? (exposure as unknown as Option<SpStakingExposurePage>).unwrap().others
                    : [];
            individualExposure.forEach(({ who }, validatorIndex): void => {
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
    let storageKeys: KeysAndExposures = [];
    let validatorsOverviewEntries: [StorageKey, Option<SpStakingPagedExposureMetadata>][] = [];

    const validatorIndex: ValidatorIndex = {};

    if (historicApi.query.staking.erasStakersClipped) {
        storageKeys = await historicApi.query.staking.erasStakersClipped.entries(eraIndex);
    } else {
        const validators: Vec<AccountId> = (await historicApi.query.staking.currentElected()) as Vec<AccountId>;

        const validatorId: AccountId[] = [];

        validators.map((validator, index) => {
            validatorIndex[validator.toString()] = index;
            validatorId.push(validator);
        });

        let eraExposure: SpStakingExposure = {} as SpStakingExposure;

        for (const validator of validatorId) {
            const storageKey = {
                args: [eraIndex, validator],
            } as unknown as StorageKey<[EraIndex, AccountId]>;
            eraExposure = (await historicApi.query.staking.stakers(validator)) as unknown as SpStakingExposure;
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
    eraRewardPoints: PalletStakingEraRewardPoints | EraPoints,
    validatorId: string,
    validatorIndex?: ValidatorIndex,
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

const extractExposure = (address: string, validatorId: string, deriveEraExposure: IAdjustedDeriveEraExposure) => {
    // Get total stake behind validator
    let totalExposure = {} as Compact<u128>;
    if (deriveEraExposure.validators[validatorId].total) {
        totalExposure = deriveEraExposure.validators[validatorId].total;
    } else if (deriveEraExposure.validatorsOverview) {
        totalExposure = deriveEraExposure.validatorsOverview[validatorId].isSome
            ? deriveEraExposure.validatorsOverview[validatorId].unwrap().total
            : ({} as unknown as Compact<u128>);
    }

    // Get nominators stake behind validator
    let exposureAllNominators: SpStakingIndividualExposure[] = [];
    if (deriveEraExposure.validators[validatorId].others) {
        exposureAllNominators = deriveEraExposure.validators[validatorId].others;
    } else {
        const exposure = deriveEraExposure.validators[validatorId] as unknown as Option<SpStakingExposurePage>;

        exposureAllNominators = exposure.isSome
            ? ((exposure as unknown as Option<SpStakingExposurePage>).unwrap()
                .others as unknown as SpStakingIndividualExposure[])
            : ([] as SpStakingIndividualExposure[]);
    }
    let nominatorExposure;
    // check `address === validatorId` is when the validator is also the nominator we are getting payouts for
    if (address === validatorId && deriveEraExposure.validators[address].own) {
        nominatorExposure = deriveEraExposure.validators[address].own;
    } else if (address === validatorId && deriveEraExposure.validatorsOverview) {
        nominatorExposure = deriveEraExposure.validatorsOverview[address].isSome
            ? deriveEraExposure.validatorsOverview[address].unwrap().own
            : ({} as unknown as Compact<u128>);
    } else {
        nominatorExposure = exposureAllNominators.find((exposure) => exposure.who.toString() === address)?.value;
    }
    return {
        totalExposure,
        nominatorExposure,
    };
}

const deriveNominatedExposures = (
    address: string,
    deriveEraExposure: IAdjustedDeriveEraExposure,
): DeriveEraExposureNominating[] | undefined => {
    let nominatedExposures: DeriveEraExposureNominating[] = deriveEraExposure.nominators[address] ?? [];
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

const main = async (validatorId: string, eraStart: number, eraEnd: number, url: string) => {
    const range = eraEnd - eraStart;
    const validatorPayouts: IValidatorsPayoutInfo[] = [];
    const wsProvider = new WsProvider(url);
    const api = new ApiPromise({
        provider: wsProvider,
    })

    await api.isReady;

    const lastEra = await api.query.staking.currentEra();
    const polkaEras = polkadotErasInfo;

    for (let e = 0; e < range; e++) {
        let era = eraStart + e;
        let blockNumber = polkaEras[era + 1].block_number;
        let hash = await api.rpc.chain.getBlockHash(blockNumber);

        let historicApi = await api.at(hash);
        let currentEra = await historicApi.query.staking.currentEra();

        const payouts = await fetchAccountStakingPayout(api, hash, validatorId, 0, era, false, currentEra.unwrap().toNumber(), historicApi);

        let discardedEra = era + 84 > lastEra.unwrap().toNumber() ? lastEra.unwrap().toNumber() : era + 84;

        let discardedBlock = polkaEras[discardedEra].block_number;

        let discardedHash = await api.rpc.chain.getBlockHash(discardedBlock);

        let discardedApi = await api.at(discardedHash);

        let palletversion = (await api.query.staking.palletVersion()) as unknown as u16;

        let isClaimed = false;

        if (palletversion.toNumber() < 13) {
            let ledger = await discardedApi.query.staking.ledger(validatorId);
            isClaimed = (ledger.unwrap() as unknown as LegacyPalletStakingStakingLedger).claimedRewards.includes(era as unknown as u32);
        } else if (palletversion.toNumber() < 14) {
            let ledger = await discardedApi.query.staking.ledger(validatorId);
            isClaimed = ledger.unwrap().legacyClaimedRewards.includes(era as unknown as u32);
        } else {
            let ledger = await discardedApi.query.staking.ledger(validatorId);
            let claimed = await discardedApi.query.staking.claimedRewards(era, validatorId);
            isClaimed = ledger.unwrap().legacyClaimedRewards.includes(era as unknown as u32) || claimed.includes(era as unknown as u32);
        }

        validatorPayouts.push({validatorId, era, payout: (payouts.erasPayouts[0] as IEraPayouts).totalEraPayout.toString(), wasClaimed: isClaimed} )
    }

    // What's left:
    // 1. Set the yarn script to run this, it should build the script and, run it taking the
    // necessary inputs
    // 2. Make the script save `validatorPayouts` as a JSON file.
    // 3. See if it actually works
    // 4. Add the execution phase of this (the main(...).catch() and so on)
    // 5. Maybe add the duplicates stuff frim the latest PR
    // 6. I think it also needs a  tsconfig file
}

