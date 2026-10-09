import type { FilterFieldCatalog } from '../../utils/filterTree.js';

/** Fields usable in advanced (nested AND/OR) student filters. */
export const STUDENT_FILTER_FIELDS: FilterFieldCatalog = {
  status: { label: 'Student status', type: 'text', group: 'Record' },
  studentNumber: { label: 'Student number', type: 'number', group: 'Record' },
  createdAt: { label: 'Converted on', type: 'date', group: 'Record' },
  updatedAt: { label: 'Updated', type: 'date', group: 'Record' },

  branchId: { label: 'Branch', type: 'reference', refType: 'branch', group: 'Ownership' },
  assignedCounsellor: { label: 'Counsellor', type: 'reference', refType: 'user', group: 'Ownership' },
  assignedManager: { label: 'Manager', type: 'reference', refType: 'user', group: 'Ownership' },

  preferredCountries: { label: 'Preferred country', type: 'lookup', lookupType: 'country', group: 'Preference' },
  preferredCourses: { label: 'Preferred course', type: 'lookup', lookupType: 'course', group: 'Preference' },
  degreeLevel: { label: 'Degree level', type: 'lookup', lookupType: 'degree_level', group: 'Preference' },
  intake: { label: 'Intake', type: 'lookup', lookupType: 'intake', group: 'Preference' },
  budget: { label: 'Budget', type: 'number', group: 'Preference' },

  testType: { label: 'Has test', type: 'text', path: 'testScores.test', group: 'Tests' },
  testOverall: { label: 'Any test overall score', type: 'number', path: 'testScores.overall', group: 'Tests' },
  educationLevel: { label: 'Education level', type: 'text', path: 'education.level', group: 'Education' },
  passingYear: { label: 'Passing year', type: 'number', path: 'education.passingYear', group: 'Education' },
  totalExperienceMonths: { label: 'Work experience (months)', type: 'number', group: 'Education' },

  dateOfBirth: { label: 'Date of birth', type: 'date', group: 'Personal' },
  gender: { label: 'Gender', type: 'text', group: 'Personal' },
  city: { label: 'City', type: 'text', group: 'Personal' },
  passportExpiry: { label: 'Passport expiry', type: 'date', path: 'passport.expiryDate', group: 'Personal' },
  passportNumber: { label: 'Passport', type: 'text', path: 'passport.number', group: 'Personal' },
};
