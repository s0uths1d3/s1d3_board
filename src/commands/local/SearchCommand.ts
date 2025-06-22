import type {Command} from "~/src/commands/Command";

export class SearchCommand implements Command {
    execute(event?: { state: string }): Promise<void> {
        return Promise.resolve(undefined);
    }
}