import type {Command} from "~/src/commands/Command";

export class SearchCommand implements Command {
    execute(event?: { state: string }): Promise<void> {
        console.log('f')
        return Promise.resolve(undefined);
    }
}