import type { UserSelectComponent } from "@/core/schema/types";
import { DefaultValuesEditor } from "./DefaultValuesEditor";
import { SelectBaseFields } from "./SelectShared";

interface Props {
  node: UserSelectComponent;
}

export function UserSelectInspector({ node }: Props) {
  return (
    <>
      <SelectBaseFields node={node} />
      <DefaultValuesEditor node={node} allowedTypes={["user"]} />
    </>
  );
}
