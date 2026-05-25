import type { MentionableSelectComponent } from "@/core/schema/types";
import { DefaultValuesEditor } from "./DefaultValuesEditor";
import { SelectBaseFields } from "./SelectShared";

interface Props {
  node: MentionableSelectComponent;
}

export function MentionableSelectInspector({ node }: Props) {
  return (
    <>
      <SelectBaseFields node={node} />
      <DefaultValuesEditor node={node} allowedTypes={["user", "role"]} />
    </>
  );
}
