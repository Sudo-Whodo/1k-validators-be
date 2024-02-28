import { Job, JobConfig, JobRunnerMetadata } from "../JobsClass";
import logger from "../../../logger";
import { Constants, queries, Util } from "../../../index";
import { CronJob } from "cron";
import { cronLabel } from "../cron/StartCronJobs";
import { jobStatusEmitter } from "../../../Events";
import { JobNames } from "../JobConfigs";

export class ExecutionJob extends Job {
  constructor(jobConfig: JobConfig, jobRunnerMetadata: JobRunnerMetadata) {
    super(jobConfig, jobRunnerMetadata);
  }
}

export const executionJob = async (
  metadata: JobRunnerMetadata,
): Promise<void> => {
  const {
    constraints,
    ending,
    config,
    chaindata,
    nominatorGroups,
    nominating,
    currentEra,
    bot,
    handler,
  } = metadata;

  const timeDelayBlocks = config.proxy?.timeDelayBlocks
    ? Number(config.proxy?.timeDelayBlocks)
    : Number(Constants.TIME_DELAY_BLOCKS);
  const executionFrequency = config.cron?.execution
    ? config.cron?.execution
    : Constants.EXECUTION_CRON;
  logger.info(
    `Starting Execution Job with frequency ${executionFrequency} and time delay of ${timeDelayBlocks} blocks`,
    cronLabel,
  );

  const executionCron = new CronJob(executionFrequency, async () => {
    logger.info(`Running execution cron`, cronLabel);
    const latestBlock = await chaindata.getLatestBlock();
    if (!latestBlock) {
      logger.error(`latest block is null`, cronLabel);
      return;
    }
    const api = handler.getApi();

    if (!api) {
      logger.error(`api is null`, cronLabel);
      return;
    }

    const era = await chaindata.getCurrentEra();
    if (!era) {
      logger.error(`current era is null`, cronLabel);
      return;
    }

    const allDelayed = await queries.getAllDelayedTxs();

    for (const [index, data] of allDelayed.entries()) {
      const progressPercentage = ((index + 1) / allDelayed.length) * 100;
      jobStatusEmitter.emit("jobProgress", {
        name: JobNames.Execution,
        progress: progressPercentage,
        updated: Date.now(),
        iteration: `Processed transaction: ${data.callHash}`,
      });

      const { number: dataNum, controller, targets, callHash } = data;

      let validCommission = true;

      // find the nominator
      const nomGroup = nominatorGroups.find((nom) => {
        return nom.bondedAddress == controller;
      });
      if (!nomGroup) {
        logger.error(
          `Nominator group not found for controller: ${controller}`,
          cronLabel,
        );
        continue;
      }
      const nominator = nominatorGroups.find(
        (nom) => nom.bondedAddress == controller,
      );
      if (!nominator) {
        logger.error(`nominator not found for controller: ${controller}`);
        continue;
      }
      const [bonded, err] = await chaindata.getBondedAmount(nominator.address);

      for (const target of targets) {
        const [commission, err] = await chaindata.getCommission(target);
        if (commission > config.constraints.commission) {
          validCommission = false;
          logger.warn(
            `${target} has invalid commission: ${commission}`,
            cronLabel,
          );
          if (bot) {
            await bot.sendMessage(
              `@room ${target} has invalid commission: ${commission}`,
            );
          }
        }
      }

      if (!validCommission) {
        const announcements = await chaindata.getProxyAnnouncements(
          nominator.address,
        );
        for (const announcement of announcements) {
          if (announcement.callHash == callHash) {
            logger.warn(`Cancelling call with hash: ${callHash}`, cronLabel);
            if (bot) {
              await bot.sendMessage(`Cancelling call with hash: ${callHash}`);
            }
            await nominator.cancelTx(announcement);
          }
        }
      }

      const shouldExecute =
        validCommission && dataNum + Number(timeDelayBlocks) <= latestBlock;

      if (shouldExecute) {
        logger.info(
          `tx first announced at block ${dataNum} is ready to execute. Executing....`,
          cronLabel,
        );

        // time to execute

        const innerTx = api.tx.staking.nominate(targets);
        const tx = api.tx.proxy.proxyAnnounced(
          nominator.address,
          controller,
          "Staking", // TODO: Add dynamic check for  proxy type - if the proxy type isn't a "Staking" proxy, the tx will fail
          innerTx,
        );

        const [didSend, finalizedBlockHash] = await nominator.sendStakingTx(
          tx,
          targets,
        );

        logger.info(
          `sent staking tx: ${didSend} finalizedBlockHash: ${finalizedBlockHash}`,
          cronLabel,
        );

        if (didSend) {
          // Create a Nomination Object
          jobStatusEmitter.emit("jobProgress", {
            name: JobNames.Execution,
            progress: progressPercentage, // You can adjust this if needed
            updated: Date.now(),
            iteration: `Executed transaction: ${data.callHash}`,
          });
          await queries.setNomination(
            controller,
            era,
            targets,
            bonded,
            finalizedBlockHash || "",
          );

          // Log Execution
          const validatorsMessage = (
            await Promise.all(
              targets.map(async (n) => {
                const name = await queries.getCandidate(n);
                if (!name) {
                  logger.info(`did send: no entry for :${n}`, cronLabel);
                }
                if (name && !name.name) {
                  logger.info(`did send: no name for :${n}`, cronLabel);
                }
                if (n && name) {
                  return `- ${name.name} (${Util.addressUrl(n, config)})`;
                } else {
                  logger.info(
                    `did send: n: ${n} name: ${JSON.stringify(name)}`,
                    cronLabel,
                  );
                }
              }),
            )
          ).join("<br>");
          const validatorsHtml = (
            await Promise.all(
              targets.map(async (n) => {
                const name = await queries.getCandidate(n);
                if (name) {
                  return `- ${name.name} (${Util.addressUrl(n, config)})`;
                } else {
                  return `- ${JSON.stringify(
                    name,
                  )} (Invalid name!) (${Util.addressUrl(n, config)})`;
                }
              }),
            )
          ).join("<br>");
          const message = `${Util.addressUrl(
            nominator?.address || "",
            config,
          )} executed announcement in finalized block #${finalizedBlockHash} annouced at #${dataNum} \n Validators Nominated:\n ${validatorsMessage}`;
          logger.info(message);
          if (bot) {
            await bot.sendMessage(
              `${Util.addressUrl(
                nominator?.address || "",
                config,
              )} executed announcement in finalized block #${finalizedBlockHash} announced at block #${dataNum} <br> Validators Nominated:<br> ${validatorsHtml}`,
            );
          }

          await queries.deleteDelayedTx(dataNum, controller);
        }
        await Util.sleep(7000);
      }
    }
    jobStatusEmitter.emit("jobProgress", {
      name: JobNames.Execution,
      progress: 100,
      updated: Date.now(),
      message: "All transactions processed",
    });
  });
  executionCron.start();
};
