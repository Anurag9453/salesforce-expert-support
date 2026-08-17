trigger IssueInformationTrigger on Issue_Information__c (after insert) {
    // After insert only. The email is a notification about something that has
    // already happened, and sending it before the record is committed would mean
    // telling someone about an enquiry a rollback could still erase.
    if (Trigger.isAfter && Trigger.isInsert) {
        IssueNotificationHandler.notifyOwners(Trigger.new);
    }
}