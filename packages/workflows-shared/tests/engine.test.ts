import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
import { InstanceEvent, InstanceStatus } from "../src";
import type {
	DatabaseInstance,
	DatabaseVersion,
	DatabaseWorkflow,
	Engine,
	EngineLogs,
} from "../src/engine";
import type { ProvidedEnv } from "cloudflare:test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

async function setWorkflowEntrypoint(
	stub: DurableObjectStub<Engine>,
	callback: (event: unknown, step: WorkflowStep) => Promise<unknown>
) {
	const ctx = createExecutionContext();
	await runInDurableObject(stub, (instance) => {
		// @ts-expect-error this is only a stub for WorkflowEntrypoint
		instance.env.USER_WORKFLOW = new (class {
			constructor(
				// eslint-disable-next-line @typescript-eslint/no-shadow
				protected ctx: ExecutionContext,
				// eslint-disable-next-line @typescript-eslint/no-shadow
				protected env: ProvidedEnv
			) {}
			public async run(
				event: Readonly<WorkflowEvent<unknown>>,
				step: WorkflowStep
			): Promise<unknown> {
				return await callback(event, step);
			}
		})(ctx, env);
	});
}

async function runWorkflow(
	instanceId: string,
	callback: (event: unknown, step: WorkflowStep) => Promise<unknown>
): Promise<DurableObjectStub<Engine>> {
	const engineId = env.ENGINE.idFromName(instanceId);
	const engineStub = env.ENGINE.get(engineId);

	await setWorkflowEntrypoint(engineStub, callback);

	await engineStub.init(
		12346,
		{} as DatabaseWorkflow,
		{} as DatabaseVersion,
		{} as DatabaseInstance,
		{ payload: {}, timestamp: new Date(), instanceId: "some-instance-id" }
	);

	return engineStub;
}

async function runWorkflowDefer(
	instanceId: string,
	callback: (event: unknown, step: WorkflowStep) => Promise<unknown>
): Promise<DurableObjectStub<Engine>> {
	const engineId = env.ENGINE.idFromName(instanceId);
	const engineStub = env.ENGINE.get(engineId);

	await setWorkflowEntrypoint(engineStub, callback);

	void engineStub.init(
		12346,
		{} as DatabaseWorkflow,
		{} as DatabaseVersion,
		{} as DatabaseInstance,
		{ payload: {}, timestamp: new Date(), instanceId: "some-instance-id" }
	);

	return engineStub;
}

describe("Engine", () => {
	it("should not retry after NonRetryableError is thrown", async () => {
		const engineStub = await runWorkflow(
			"MOCK-INSTANCE-ID",
			async (event, step) => {
				await step.do("should only have one retry", async () => {
					throw new NonRetryableError("Should only retry once");
				});
			}
		);

		const logs = (await engineStub.readLogs()) as EngineLogs;

		expect(
			logs.logs.some((val) => val.event == InstanceEvent.WORKFLOW_FAILURE)
		).toBe(true);
		expect(
			logs.logs.filter((val) => val.event == InstanceEvent.ATTEMPT_START)
		).toHaveLength(1);
	});

	it("should not error out if step fails but is try-catched", async () => {
		const engineStub = await runWorkflow(
			"MOCK-INSTANCE-ID",
			async (event, step) => {
				try {
					await step.do(
						"always errors out",
						{
							retries: {
								limit: 0,
								delay: 1000,
							},
						},
						async () => {
							throw new Error("Step errors out");
						}
					);
				} catch {}
				return "finished";
			}
		);

		const logs = (await engineStub.readLogs()) as EngineLogs;

		expect(
			logs.logs.some((val) => val.event == InstanceEvent.WORKFLOW_SUCCESS)
		).toBe(true);

		expect(
			logs.logs.filter((val) => val.event == InstanceEvent.ATTEMPT_FAILURE)
		).toHaveLength(1);
	});

	it("waitForEvent should receive events while active", async () => {
		const engineStub = await runWorkflowDefer(
			"MOCK-INSTANCE-ID",
			async (_, step) => {
				return await step.waitForEvent("i'm a event!", {
					type: "event-type-1",
					timeout: "10 seconds",
				});
			}
		);

		await vi.waitUntil(async () => {
			const logs = (await engineStub.readLogs()) as EngineLogs;
			return logs.logs.filter((val) => val.event == InstanceEvent.WAIT_START);
		}, 500);

		await engineStub.receiveEvent({
			type: "event-type-1",
			timestamp: new Date(),
			payload: {},
		});

		await vi.waitUntil(async () => {
			const logs = (await engineStub.readLogs()) as EngineLogs;
			return logs.logs.filter(
				(val) => val.event == InstanceEvent.WORKFLOW_SUCCESS
			);
		}, 500);
	});

	it("waitForEvent should receive events even if not active", async () => {
		const engineStub = await runWorkflowDefer(
			"MOCK-INSTANCE-ID",
			async (_, step) => {
				return await step.waitForEvent("i'm a event!", {
					type: "event-type-1",
					timeout: "10 seconds",
				});
			}
		);

		await vi.waitUntil(async () => {
			const logs = (await engineStub.readLogs()) as EngineLogs;
			return logs.logs.filter((val) => val.event == InstanceEvent.WAIT_START);
		}, 500);

		try {
			await runInDurableObject(engineStub, async (_, state) => {
				state.abort("kabooom");
			});
		} catch {
			// supposed to error out
		}

		await engineStub.receiveEvent({
			type: "event-type-1",
			timestamp: new Date(),
			payload: {},
		});

		await vi.waitUntil(async () => {
			const logs = (await engineStub.readLogs()) as EngineLogs;
			return logs.logs.filter(
				(val) => val.event == InstanceEvent.WORKFLOW_SUCCESS
			);
		}, 500);
	});

	it("should restore state from storage when accountId is undefined", async () => {
		const instanceId = "RESTORE-TEST-INSTANCE";
		const accountId = 12345;
		const workflow: DatabaseWorkflow = {
			name: "test-workflow",
			id: "workflow-123",
			created_on: new Date().toISOString(),
			modified_on: new Date().toISOString(),
			script_name: "test-script",
			class_name: "TestWorkflow",
			triggered_on: null,
		};
		const version: DatabaseVersion = {
			id: "version-123",
			class_name: "TestWorkflow",
			created_on: new Date().toISOString(),
			modified_on: new Date().toISOString(),
			workflow_id: workflow.id,
			mutable_pipeline_id: "pipeline-123",
		};
		const instance: DatabaseInstance = {
			id: instanceId,
			created_on: new Date().toISOString(),
			modified_on: new Date().toISOString(),
			workflow_id: workflow.id,
			version_id: version.id,
			status: InstanceStatus.Running,
			started_on: new Date().toISOString(),
			ended_on: null,
		};
		const event = {
			payload: {},
			timestamp: new Date(),
			instanceId: instanceId,
		};

		const engineStub = await runWorkflow(instanceId, async () => {
			return "test";
		});

		await runInDurableObject(engineStub, async (engine) => {
			await engine.init(accountId, workflow, version, instance, event);
			await engine.setStatus(accountId, instanceId, InstanceStatus.Running);
			await engine.abort("kaboom");
		});

		const engineId = env.ENGINE.idFromName(instanceId);
		const restartedStub = env.ENGINE.get(engineId);

		const status = await runInDurableObject(restartedStub, (engine) => {
			return engine.getStatus(accountId, instanceId);
		});

		expect(status).toBe(InstanceStatus.Running);

		const logs = (await restartedStub.readLogs()) as EngineLogs;
		expect(
			logs.logs.some((log) => log.event === InstanceEvent.WORKFLOW_START)
		).toBe(true);
	});
});
