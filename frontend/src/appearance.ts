import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { request, useData } from "./api";
import { verifyOnPhone } from "./phone-verification";
import type { Preferences } from "./types";
import { themes, type Theme } from "./themes";

// Older running servers do not advertise a catalog. Never send them new IDs.
export function supportedThemes(preferences?: Preferences): readonly Theme[] {
  return (
    preferences?.supported_themes ?? [
      "light",
      "midnight",
      "forest",
      "obsidian",
      "aurora",
      "sandstone",
    ]
  );
}
export function useAppearance() {
  const client = useQueryClient();
  const preferences = useData<Preferences>("preferences", "/preferences");
  const access = useData<{ local: boolean }>("access", "/access/status");
  const pending = useIsMutating({ mutationKey: ["appearance"] }) > 0;
  const mutation = useMutation({
    mutationKey: ["appearance"],
    mutationFn: async (patch: Partial<Preferences>) => {
      if (
        patch.theme &&
        !supportedThemes(preferences.data).includes(patch.theme)
      )
        throw new Error(
          "Restart Varshan to enable this theme, then refresh the page.",
        );
      const verification =
        patch.privacy_mode === false && access.data?.local === false
          ? await verifyOnPhone()
          : undefined;
      return request<Preferences>("/preferences", {
        ...patch,
        ...(verification ? { verification } : {}),
      });
    },
    onSuccess: (saved) => client.setQueryData(["preferences"], saved),
  });
  return {
    ...mutation,
    isPending: pending,
    ready: !!preferences.data,
    themes: themes.filter((theme) =>
      supportedThemes(preferences.data).includes(theme.id),
    ),
  };
}
