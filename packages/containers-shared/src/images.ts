import { buildImage } from "./build";
import {
	getCloudflareContainerRegistry,
	isCloudflareRegistryLink,
} from "./knobs";
import { dockerLoginManagedRegistry } from "./login";
import {
	checkExposedPorts,
	runDockerCmd,
	verifyDockerInstalled,
} from "./utils";
import type { ContainerDevOptions, DockerfileConfig } from "./types";

export async function pullImage(
	dockerPath: string,
	options: Exclude<ContainerDevOptions, DockerfileConfig>
): Promise<{ abort: () => void; ready: Promise<void> }> {
	await dockerLoginManagedRegistry(dockerPath);
	const pull = runDockerCmd(dockerPath, [
		"pull",
		options.image_uri,
		// All containers running on our platform need to be built for amd64 architecture, but by default docker pull seems to look for an image matching the host system, so we need to specify this here
		"--platform",
		"linux/amd64",
	]);
	const ready = pull.ready.then(async ({ aborted }: { aborted: boolean }) => {
		if (!aborted) {
			// re-tag image with the expected dev-formatted image tag for consistency
			await runDockerCmd(dockerPath, [
				"tag",
				options.image_uri,
				options.image_tag,
			]);
		}
	});

	return {
		abort: () => {
			pull.abort();
		},
		ready,
	};
}

/**
 *
 * Builds or pulls the container images for local development. This
 * will be called before starting the local development server, and by a rebuild
 * hotkey during development.
 *
 * Because this runs when local dev starts, we also do some validation here,
 * such as checking if the Docker CLI is installed, and if the container images
 * expose any ports.
 */
export async function prepareContainerImagesForDev(args: {
	dockerPath: string;
	containerOptions: ContainerDevOptions[];
	onContainerImagePreparationStart: (args: {
		containerOptions: ContainerDevOptions;
		abort: () => void;
	}) => void;
	onContainerImagePreparationEnd: (args: {
		containerOptions: ContainerDevOptions;
	}) => void;
}) {
	const {
		dockerPath,
		containerOptions,
		onContainerImagePreparationStart,
		onContainerImagePreparationEnd,
	} = args;
	let aborted = false;
	if (process.platform === "win32") {
		throw new Error(
			"Local development with containers is currently not supported on Windows. You should use WSL instead. You can also set `enable_containers` to false if you do not need to develop the container part of your application."
		);
	}
	await verifyDockerInstalled(dockerPath);
	for (const options of containerOptions) {
		if ("dockerfile" in options) {
			const build = await buildImage(dockerPath, options);
			onContainerImagePreparationStart({
				containerOptions: options,
				abort: () => {
					aborted = true;
					build.abort();
				},
			});
			await build.ready;
			onContainerImagePreparationEnd({
				containerOptions: options,
			});
		} else {
			if (!isCloudflareRegistryLink(options.image_uri)) {
				throw new Error(
					`Image "${options.image_uri}" is a registry link but does not point to the Cloudflare container registry.\n` +
						`To use an existing image from another repository, see https://developers.cloudflare.com/containers/image-management/#using-existing-images`
				);
			}
			const pull = await pullImage(dockerPath, options);
			onContainerImagePreparationStart({
				containerOptions: options,
				abort: () => {
					aborted = true;
					pull.abort();
				},
			});
			await pull.ready;
			onContainerImagePreparationEnd({
				containerOptions: options,
			});
		}
		if (!aborted) {
			await checkExposedPorts(dockerPath, options);
		}
	}
}

/**
 * Resolve an image name to the full unambiguous name.
 *
 * For now, this only converts images stored in the managed registry to contain
 * the user's account ID in the path.
 */
export function resolveImageName(accountId: string, image: string): string {
	let url: URL;
	try {
		url = new URL(`http://${image}`);
	} catch {
		return image;
	}

	if (url.hostname !== getCloudflareContainerRegistry()) {
		return image;
	}

	if (url.pathname.startsWith(`/${accountId}`)) {
		return image;
	}

	return `${url.hostname}/${accountId}${url.pathname}`;
}
