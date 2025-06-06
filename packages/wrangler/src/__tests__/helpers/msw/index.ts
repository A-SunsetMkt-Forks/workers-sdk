import { setupServer } from "msw/node";
import { default as mswAccessHandlers } from "./handlers/access";
import {
	mswSuccessDeploymentDetails,
	mswSuccessDeployments,
	mswSuccessDeploymentScriptAPI,
	mswSuccessDeploymentScriptMetadata,
} from "./handlers/deployments";
import { mswSuccessNamespacesHandlers } from "./handlers/namespaces";
import { mswSuccessOauthHandlers } from "./handlers/oauth";
import { mswR2handlers } from "./handlers/r2";
import { default as mswSucessScriptHandlers } from "./handlers/script";
import { mswSuccessUserHandlers } from "./handlers/user";
import {
	mswGetVersion,
	mswListNewDeployments,
	mswListVersions,
	mswPatchNonVersionedScriptSettings,
	mswPostNewDeployment,
} from "./handlers/versions";
import { default as mswZoneHandlers } from "./handlers/zones";

export const msw = setupServer();

function createFetchResult(
	result: unknown,
	success = true,
	errors: unknown[] = [],
	messages: unknown[] = [],
	result_info?: Record<string, unknown>
) {
	return result_info
		? {
				result,
				success,
				errors,
				messages,
				result_info,
			}
		: {
				result,
				success,
				errors,
				messages,
			};
}

export {
	createFetchResult,
	mswSuccessUserHandlers,
	mswR2handlers,
	mswSuccessOauthHandlers,
	mswSuccessNamespacesHandlers,
	mswSucessScriptHandlers,
	mswZoneHandlers,
	mswSuccessDeployments,
	mswSuccessDeploymentDetails,
	mswAccessHandlers,
	mswSuccessDeploymentScriptMetadata,
	mswSuccessDeploymentScriptAPI,
	mswPostNewDeployment,
	mswGetVersion,
	mswListNewDeployments,
	mswListVersions,
	mswPatchNonVersionedScriptSettings,
};
